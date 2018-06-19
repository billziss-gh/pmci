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
            },
        ],
        "metadata":
        {
            "items":
            [
                {
                    "key": "startup-script",
                    "value": package.config.FREEBSD_STARTX,
                },
            ],
        },
    },
}

const pubcli = new pubsub.v1.PublisherClient()
const subcli = new pubsub.v1.SubscriberClient()
const project = package.config.PROJECT

exports.listener = (req, rsp) =>
{
    // check X-Hub-Signature to ensure that GitHub is accessing us

    if (req.query.image === undefined ||
        req.query.token === undefined)
    {
        rsp.status(400).send("query: missing image or token")
        return
    }

    if (req.body.repository === undefined ||
        req.body.repository.clone_url === undefined ||
        req.body.after === undefined)
    {
        rsp.status(400).send("body: missing clone_url or commit")
        return
    }

    // post event to workq
    attributes =
    {
        image: req.query.image,
        token: req.query.token,
        clone_url: req.body.repository.clone_url,
        commit: req.body.after,
    }
    queue_post(req.query.image + "-workq", attributes).
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
    // received message from workq
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes.image === undefined ||
        message.attributes.token === undefined ||
        message.attributes.clone_url === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid workq message: " +
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

            // prepare builder args
            args = ""
            args += `BUILDER_ARG_SRCHOST_TOKEN=${message.attributes.token}`
            args += `BUILDER_ARG_CLONE_URL=${message.attributes.clone_url}\n`
            if (message.attributes.commit !== undefined)
                args += `BUILDER_ARG_COMMIT=${message.attributes.commit}\n`

            // create builder instance
            conf = vmconf[message.attributes.image].clone()
            conf.metadata.items[0].value = args + c.metadata.items[0].value
            return zone.vm(poolmsg.attributes.instance).create(conf).
                then(_ =>
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

exports.collector = (evt) =>
{
    message = evt.data

    if (message.data == null)
    {
        // discard the erroneous message
        console.error("invalid doneq message: " +
            String(message))
        return Promise.resolve()
    }

    message = JSON.parse(Buffer(message.data, "base64").toString()).jsonPayload

    switch (message.event_subtype)
    {
    case "compute.instances.stop":
    case "compute.instances.guestTerminate":
        return zone.vm(message.resource.name).delete()
    case "compute.instances.delete":
        attributes =
        {
            instance: message.resource.name,
        }
        return queue_post("poolq", attributes)
    default:
        // discard the erroneous message
        console.error("invalid doneq message: unknown event_subtype: " +
            String(message))
        return Promise.resolve()
    }
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
