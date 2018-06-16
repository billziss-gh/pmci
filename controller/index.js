/*
 * index.js
 *
 * Copyright 2018 Bill Zissimopoulos
 */
/*
 * This file is part of "Poor Man's CI".
 *
 * It is licensed under the BSD license. The full license text can be found
 * in the License.txt file at the root of this project.
 */

/*
 * The controller consists of a number of Cloud Functions:
 *
 * - listener: An HTTP Function that listens for GitHub push events and publishes them in acptq
 *   ("accept" q).
 * - scheduler: A Background Retry Function that listens for acptq messages. When it receives one
 *   it attempts to pull a free builder instance from poolq and if successful it starts that
 *   instance and publishes the received message to workq. In this case the message is not retried.
 * - completer: A Background Retry Function that listens for doneq messages (posted by builders).
 *   When it receives one it posts a GitHub commit status update.
 *
 * Builders are not part of the controller. They pull messages from the workq, perform the work
 * described and then post messages in the doneq and delete themselves.
 */

const package = require("./package.json")
const compute = require("@google-cloud/compute")
const pubsub = require("@google-cloud/pubsub")

const zone = new compute().zone(package.config.BUILDER_ZONE)
const vmconf =
{
    "freebsd":
    {
        "machineType": package.config.BUILDER_MACHINE_TYPE,
        "minCpuPlatform": package.config.BUILDER_MIN_CPU_PLATFORM,
        "disks":
        [
            {
                "boot": true,
                "initializeParams":
                {
                    "sourceImage": "freebsd-org-cloud-dev/freebsd-11-1-release-amd64",
                    "diskSizeGb": package.config.BUILDER_DISK_SIZE,
                },
                "autoDelete": true,
            }
        ],
        "metadata":
        {
            "items":
            {
                "key": "startup-script",
                "value": package.config.FREEBSD_STARTX,
            },
        },
    },
}

const pubcli = new pubsub.v1.PublisherClient()
const subcli = new pubsub.v1.SubscriberClient()
const project = package.config.PROJECT

exports.listener = (req, rsp) =>
{
    // check X-Hub-Signature to ensure that GitHub is accessing us

    if (req.query.image === undefined)
    {
        rsp.status(400).send("query: missing image")
        return
    }

    if (req.body.repository === undefined ||
        req.body.repository.clone_url === undefined ||
        req.body.after === undefined)
    {
        rsp.status(400).send("body: missing clone_url or commit")
        return
    }

    // post event to acptq
    attributes =
    {
        image: req.query.image,
        clone_url: req.body.repository.clone_url,
        commit: req.body.after,
    }
    queue_post(req.query.image + "-acptq", attributes).
        then(_ =>
        {
            rsp.status(200).end()
        }).
        catch(err =>
        {
            console.error(err)
            rsp.status(500).end()
        })
}

exports.scheduler = (evt) =>
{
    // received message from acptq
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes.image === undefined ||
        message.attributes.clone_url === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid acptq message: " +
            String(message))
        return Promise.resolve()
    }

    // pull instance from poolq
    return queue_recv("poolq").
        then(responses =>
        {
            response = responses[0]
            if (response.received_messages.length == 0)
                return Promise.reject("retry: no pool instance: " +
                    String(message.attributes.clone_url) + " " +
                    String(message.attributes.commit))

            poolmsg = response.received_messages[0].message
            if (poolmsg.attributes === undefined ||
                poolmsg.attributes.instance === undefined)
                return Promise.reject("retry: invalid poolq message: " +
                    String(poolmsg))

            // create builder instance
            return zone.vm(poolmsg.attributes.instance).create(vmconf[message.attributes.image]).
                then(_ =>
                {
                    // post message to workq
                    return queue_post(message.attributes.image + "-workq", message.attributes)
                })
                .then(_ =>
                {
                    // acknowledge poolq message
                    return queue_ack("poolq", ack_id)
                })
        }).
        catch(err =>
        {
            console.error(err)
            throw err
        })
}

exports.completer = (evt) =>
{
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes.instance === undefined ||
        message.attributes.clone_url === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid doneq message: " +
            String(message))
        return Promise.resolve()
    }

    // delete instance
    zone.vm(message.attributes.instance).delete().
        catch(err => console.error(err))

    // repost instance to poolq
    attributes =
    {
        instance: message.attributes.instance
    }
    queue_post("poolq", attributes).
        catch(err => console.error(err))

    // update commit status on GitHub
    // TODO

    return Promise.resolve()
}

function queue_post(topic, attributes)
{
    message =
    {
        data: "",
        attributes: attributes,
    }
    request =
    {
        topic: pubcli.topicPath(project, topic),
        messages: [message],
    }
    return pubcli.publish(request)
}

function queue_recv(topic)
{
    request =
    {
        subscription: subcli.topicPath(project, topic),
        maxMessages: 1,
        returnImmediately: true,
    }
    return subcli.pull(request)
}

function queue_recv(topic, ackId)
{
    request =
    {
        subscription: subcli.topicPath(project, topic),
        ackIds: [ackId],
    }
    return subcli.acknowledge(request)
}
