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

const project = package.config.PROJECT
const region = package.config.REGION

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
                    "sourceImage": "https://www.googleapis.com/compute/v1/" +
                        //"projects/freebsd-org-cloud-dev/global/images/freebsd-11-1-release-amd64",
                        "projects/" + project + "/global/images/freebsd-builder",
                    "diskSizeGb": package.config.BUILDER_DISK_SIZE,
                },
                "autoDelete": true,
            },
        ],
        "networkInterfaces":
        [
            {
                "accessConfigs":
                [
                    {
                        "type": "ONE_TO_ONE_NAT",
                        "name": "External NAT",
                    },
                ],
            },
        ],
        "serviceAccounts":
        [
            {
                "email": package.config.BUILDER_SERVICE_ACCOUNT,
                "scopes":
                [
                    "https://www.googleapis.com/auth/compute",
                    "https://www.googleapis.com/auth/devstorage.read_only",
                    "https://www.googleapis.com/auth/devstorage.read_write",
                    "https://www.googleapis.com/auth/logging.write",
                    "https://www.googleapis.com/auth/monitoring.write",
                    "https://www.googleapis.com/auth/pubsub",
                    "https://www.googleapis.com/auth/service.management.readonly",
                    "https://www.googleapis.com/auth/servicecontrol",
                    "https://www.googleapis.com/auth/trace.append",
                ],
            },
        ],
        "metadata":
        {
            "items":
            [
                {
                    "key": "startup-script",
                    "value": package.config.FREEBSD_BUILDER_STARTX,
                },
            ],
        },
    },
    "netbsd":
    {
        "machineType": package.config.BUILDER_MACHINE_TYPE,
        "minCpuPlatform": package.config.BUILDER_MIN_CPU_PLATFORM,
        "disks":
        [
            {
                "boot": true,
                "initializeParams":
                {
                    "sourceImage": "https://www.googleapis.com/compute/v1/" +
                        "projects/" + project + "/global/images/netbsd-builder",
                    "diskSizeGb": package.config.BUILDER_DISK_SIZE,
                },
                "autoDelete": true,
            },
        ],
        "networkInterfaces":
        [
            {
                "accessConfigs":
                [
                    {
                        "type": "ONE_TO_ONE_NAT",
                        "name": "External NAT",
                    },
                ],
            },
        ],
        "serviceAccounts":
        [
            {
                "email": package.config.BUILDER_SERVICE_ACCOUNT,
                "scopes":
                [
                    "https://www.googleapis.com/auth/compute",
                    "https://www.googleapis.com/auth/devstorage.read_only",
                    "https://www.googleapis.com/auth/devstorage.read_write",
                    "https://www.googleapis.com/auth/logging.write",
                    "https://www.googleapis.com/auth/monitoring.write",
                    "https://www.googleapis.com/auth/pubsub",
                    "https://www.googleapis.com/auth/service.management.readonly",
                    "https://www.googleapis.com/auth/servicecontrol",
                    "https://www.googleapis.com/auth/trace.append",
                ],
            },
        ],
        "metadata":
        {
            "items":
            [
                {
                    "key": "startup-script",
                    "value": package.config.NETBSD_BUILDER_STARTX,
                },
            ],
        },
    },
}

const pubcli = new pubsub.v1.PublisherClient()
const subcli = new pubsub.v1.SubscriberClient()

exports.listener = (req, rsp) =>
{
    // check if the request has our secret
    if (req.query.secret != package.config.SECRET)
    {
        rsp.status(400).send("You don't know the password!")
        return
    }

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
        req.body.repository.clone_url === undefined)
    {
        rsp.status(400).send("body: missing clone_url")
        return
    }

    if (req.body.after == "0000000000000000000000000000000000000000")
    {
        rsp.status(200).end()
        return
    }

    // post event to workq
    attributes =
    {
        image: req.query.image,
        token: req.query.token,
        clone_url: req.body.repository.clone_url,
    }
    if (req.body.after !== undefined)
        attributes.commit = req.body.after
    queue_post("workq", attributes).
        then(_ =>
        {
            console.log("workq: posted work" +
                " on " + req.query.image +
                " for " + req.body.repository.clone_url +
                " commit " + req.body.after)
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

            ackId = received[0].ack_id
            if (ackId === undefined)
                ackId = received[0].ackId
            poolmsg = received[0].message
            if (poolmsg.attributes === undefined ||
                poolmsg.attributes.instance === undefined)
            {
                // invalid poolq message; acknowledge it and retry the workq message
                queue_ack("poolq", ackId)
                return Promise.reject("poolq: skip invalid message: " + String(poolmsg))
            }

            console.log("poolq: received instance " + poolmsg.attributes.instance)

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
                    return queue_ack("poolq", ackId)
                }).
                then(_ =>
                {
                    console.log("builder: created " +
                        message.attributes.image + " instance " + poolmsg.attributes.instance +
                        " for " + message.attributes.clone_url +
                        " commit " + message.attributes.commit)
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
    instance = message.resource.name

    if (!instance.startsWith("builder"))
        return Promise.resolve("doneq: ignoring non-builder instance " + instance)

    switch (message.event_subtype)
    {
    case "compute.instances.stop":
    case "compute.instances.guestTerminate":
        return zone.vm(instance).delete().
            then(_ =>
            {
                console.log("builder: deleted " + instance)
            })
    case "compute.instances.delete":
        attributes =
        {
            instance: instance,
        }
        return queue_post("poolq", attributes).
            then(_ =>
            {
                console.log("poolq: posted instance " + instance)
            })
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
    args += `BUILDER_ARG_SRCHOST_TOKEN=${token}\n`
    args += `BUILDER_ARG_CLONE_URL=${clone_url}\n`
    if (commit !== undefined)
        args += `BUILDER_ARG_COMMIT=${commit}\n`

    // create builder instance
    conf = JSON.parse(JSON.stringify(vmconf[image]))
    conf.metadata.items[0].value = args + conf.metadata.items[0].value
    return zone.vm(instance).create(conf)
}
