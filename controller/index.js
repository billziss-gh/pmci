const PubSub = require(`@google-cloud/pubsub`);
const workq = new PubSub().topic("workq").publisher()

exports.listener = (req, rsp) =>
{
    clone_url = undefined
    commit = undefined

    if (req.body.repository !== undefined)
    {
        clone_url = req.body.repository.clone_url
        commit = req.body.after
    }

    if (clone_url === undefined || commit === undefined)
    {
        rsp.status(400).send("missing clone_url or commit")
        return
    }

    attributes =
    {
        clone_url: clone_url,
        commit: commit,
    }

    workq.publish(Buffer.alloc(0), attributes).
        then(messageId =>
        {
            rsp.status(200).send("SUCCESS")
        }).
        catch(err =>
        {
            console.error(err)
            rsp.status(500).send("FAILURE")
        })
}
