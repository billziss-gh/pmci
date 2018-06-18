# Poor Man's CI

Poor Man's CI (PMCI, Poor Man's Continuous Integration) is a collection of scripts that taken together work as a simple CI solution that runs on Google Cloud. This is useful for running automated CI for systems that lack such a solution (e.g. the BSD's).

By utilizing the Google Cloud [Always Free](https://cloud.google.com/free/docs/always-free-usage-limits) tier PMCI is not only hosted, but can also be free! (Disclaimer: I am not affiliated with Google and do not otherwise endorse their products.)

## Architecture

Our goal is to produce a CI solution that listens for GitHub [`push`](https://developer.github.com/v3/activity/events/types/#pushevent) events, builds the associated repository at the appropriate place in its history and reports the result back to GitHub. Additionally we want our CI solution to be as efficient as possible and optionally fit within Google's Always Free usage limits.

PMCI achieves these goals with an architecture that consists of the following components and their interactions:

- **Builders**: A collection of VM instances that build repositories.
    - The names of the builders are maintained in a `pool` queue (a [Google PubSub topic](https://cloud.google.com/pubsub/architecture)). Builder names are pulled from the `pool` queue and instantiated as VM instances; when a builder completes a build, its name is placed back in the `pool` queue. It is possible to have a single builder in the `pool` queue and fit within the Always Free usage limits.
    - Builders pull work from a system specific `work` queue (e.g. `freebsd-workq`), perform the work (build a repository) and then post a message to a system specific `done` queue (e.g. `freebsd-doneq`).
- **Controller**: Controls the overall process of accepting GitHub `push` events and starting builds.
    - **Listener**: A Cloud Function that listens for GitHub `push` events and posts them in a system specific `accept` queue (e.g. `freebsd-acptq`).
    - **Scheduler**: A Cloud Function that receives events from the `accept` queue. Upon receipt of an event, it attempts to pull a free builder from the `pool` queue and if successful creates the builder instance and posts a work item in a `work` queue. If the scheduler is not successful in finding a free builder, the event is not accepted and will be retried.
    - **Completer**: A cloud Function that receives events from the `done` queue. Upon receipt of the event, it deletes the builder instance, reposts the now free builder to the `pool` queue and informs GitHub of the build status.

![Sequence Diagram](doc/pmci.png)