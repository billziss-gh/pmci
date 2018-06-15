/*
 * index.js
 *
 * Copyright 2018 Bill Zissimopoulos
 */

/*
 * The controller consists of a number of Functions:
 *
 * - listener: An HTTP Function that listens for GitHub push events and publishes them in acptq
 *   ("accept" q).
 * - scheduler: A Background Retry Function that listens for acptq messages. When it receives one
 *   it attempts to pull a free builder instance from poolq and if successful it starts that
 *   instance and publishes the received message to workq. In this case the message is not retried.
 */

const compute = require('@google-cloud/compute')
const pubsub = require("@google-cloud/pubsub")

const zone = new compute().zone("${ZONE}")
const vmconf = {}

const pubcli = new pubsub.v1.PublisherClient()
const subcli = new pubsub.v1.SubscriberClient()
const project = "${PROJECT}"
const acptq = "${ACPTQ}"
const poolq = "${POOLQ}"
const workq = "${WORKQ}"
const doneq = "${DONEQ}"

exports.listener = (req, rsp) =>
{
    if (req.body.repository === undefined ||
        req.body.repository.clone_url === undefined ||
        req.body.after === undefined)
    {
        rsp.status(400).send("missing clone_url or commit")
        return
    }

    attributes =
    {
        clone_url: req.body.repository.clone_url,
        commit: req.body.after,
    }
    queue_post(acptq, attributes).
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
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes["clone_url"] === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid acptq message")
        return Promise.resolve()
    }

    return queue_recv(poolq).
        then(responses =>
        {
            response = responses[0]
            messages = response.received_messages
            if (messages.length == 0)
                // no pool instance found; retry accepted message
                return Promise.reject()

            message = messages[0].message
            if (message.attributes === undefined ||
                message.attributes["instance"] === undefined)
            {
                // invalid poolq message: retry accepted message
                console.error("invalid poolq message")
                return Promise.reject()
            }

            return queue_post(workq, message.attributes).
                then(_ =>
                {
                    return zone.createVM(message.attributes["instance"], vmconf)
                })
        })
}

exports.verifier = (evt) =>
{
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes["clone_url"] === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid doneq message")
        return Promise.resolve()
    }

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
