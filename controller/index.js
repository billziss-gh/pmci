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
 * The controller consists of a number of Functions:
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
 * described and then post messages in the doneq and delete themselves
 */

const compute = require("@google-cloud/compute")
const pubsub = require("@google-cloud/pubsub")

const zone = new compute().zone("${ZONE}")
const vmconf = {}

const pubcli = new pubsub.v1.PublisherClient()
const subcli = new pubsub.v1.SubscriberClient()
const project = "${PROJECT}"
const acptq = "${SYSTEM}-acptq"
const poolq = "${SYSTEM}-poolq"
const workq = "${SYSTEM}-workq"
//const doneq = "${SYSTEM}-doneq"

exports.listener = (req, rsp) =>
{
    // check X-Hub-Signature to ensure that GitHub is accessing us

    if (req.body.repository === undefined ||
        req.body.repository.clone_url === undefined ||
        req.body.after === undefined)
    {
        rsp.status(400).send("missing clone_url or commit")
        return
    }

    // post event to acptq
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
    // received message from acptq
    message = evt.data

    if (message.attributes === undefined ||
        message.attributes["clone_url"] === undefined)
    {
        // discard the erroneous message (absense of "commit" is allowed and means "latest")
        console.error("invalid acptq message")
        return Promise.resolve()
    }

    // pull instance from poolq
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

            // create builder instance
            return zone.createVM(message.attributes["instance"], vmconf).
                then(_ =>
                {
                    // post message to workq
                    return queue_post(workq, message.attributes)
                })
                .then(_ =>
                {
                    // acknowledge poolq message
                    return queue_ack(poolq, ack_id)
                })
        })
}

exports.completer = (evt) =>
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

function queue_recv(topic, ackId)
{
    request =
    {
        subscription: subcli.topicPath(project, topic),
        ackIds: [ackId],
    }
    return subcli.acknowledge(request)
}
