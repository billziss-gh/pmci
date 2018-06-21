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

    if (!(req.query.image in vmconf))
    {
        rsp.status(400).send("query: unknown image " + req.query.image)
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
    queue_post("workq", attributes).
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

exports.dispatcher = (evt) =>
{
    // Retry Background Function:
    // - Promise.resolve means that message is accepted.
    // - Promise.reject means that message will be retried.

    // received message from workq
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes.image === undefined ||
        message.attributes.token === undefined ||
        message.attributes.clone_url === undefined)
        // invalid workq message; do not retry
        return Promise.resolve("workq: skip invalid message: " + String(message))

    // have work; pull instance from poolq
    return queue_recv("poolq").
        then(responses =>
        {
            response = responses[0]
            received = response.received_messages
            if (response.received_messages === undefined)
                received = response.receivedMessages
            if (received === undefined ||
                received.length == 0)
            {
                // HACK: if we reject this message it will be retried immediately,
                // and we will spin unproductively. Ideally the infrastructure would
                // give us some control over when to be retried, but this is not the
                // case. So let's try the next best thing: sleep for a while instead.
                //
                // See https://tinyurl.com/yb2vbwfd
                //
                // Remove this if PubSub implements retry controls.
                return new Promise(resolve => setTimeout(resolve, 60000)).
                    then(_ =>
                    {
                        return Promise.reject("poolq: no available instance")
                    })

                // no pool instance; retry
                //return Promise.reject("poolq: no available instance")
            }

            ack_id = received[0].ack_id
            poolmsg = received[0].message
            if (poolmsg.attributes === undefined ||
                poolmsg.attributes.instance === undefined)
            {
                // invalid poolq message; acknowledge it and retry the workq message
                queue_ack("poolq", ack_id)
                return Promise.reject("poolq: skip invalid message: " + String(poolmsg))
            }

            // have builder instance name; create new builder
            return builder_create(
                message.attributes.image,
                poolmsg.attributes.instance,
                message.attributes.token,
                message.attributes.clone_url,
                message.attributes.commit).
                then(_ =>
                {
                    // acknowledge poolq message
                    return queue_ack("poolq", ack_id)
                })
        })
    }

exports.collector = (evt) =>
{
    // NO-Retry Background Function:
    // - Promise.resolve means that message is accepted.
    // - Promise.reject means error, but message is NOT retried.

    // received message from doneq
    message = evt.data

    if (message.data == null)
        return Promise.reject("doneq: skip invalid message: " + String(message))

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
        return Promise.reject("doneq: invalid message: unknown event_subtype: " + String(message))
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
        subscription: subcli.subscriptionPath(project, topic),
        maxMessages: 1,
        returnImmediately: true,
    }
    return subcli.pull(request)
}

function queue_ack(topic, ackId)
{
    request =
    {
        subscription: subcli.subscriptionPath(project, topic),
        ackIds: [ackId],
    }
    return subcli.acknowledge(request)
}

function builder_create(image, instance, token, clone_url, commit)
{
    // prepare builder args
    args = ""
    args += `BUILDER_ARG_SRCHOST_TOKEN=${token}`
    args += `BUILDER_ARG_CLONE_URL=${clone_url}\n`
    if (commit !== undefined)
        args += `BUILDER_ARG_COMMIT=${commit}\n`

    // create builder instance
    conf = JSON.parse(JSON.stringify(vmconf[image]))
    conf.metadata.items[0].value = args + conf.metadata.items[0].value
    return zone.vm(instance).create(conf)
}
