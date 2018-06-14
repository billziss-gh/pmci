builder_create()
{
    gcloud beta compute instances create \
        --machine-type=f1-micro \
        --min-cpu-platform="Intel Skylake" \
        --boot-disk-size=30GB \
        --network-tier=PREMIUM \
        --subnet=default \
        --maintenance-policy=MIGRATE \
        --scopes=default,storage-rw \
        "$@"
}

builder_build()
{
    local CLONEURL COMMIT
    eval `gcloud pubsub subscriptions pull $1 --auto-ack "--format=value(message.attributes)"`

    if [ -n "$CLONEURL" ]; then
        (
            git clone --depth 50 "$CLONEURL"
            local repo=`basename "$CLONEURL"`
            cd "${repo%.*}"

            [ -n "$COMMIT" ] && git checkout "$COMMIT"

            local os=`uname -s | tr A-Z a-z`
            if [ -f .pmci/$os.sh ]; then
                sh .pmci/$os.sh >/var/log/build.log 2>&1
                gsutil \
                    -h "Content-type:text/plain" \
                    -h "Content-Disposition" \
                    cp -a public-read /var/log/build.log gs://pmci-logs/`git rev-parse HEAD`.log
            fi
        )
    fi
}

queue_create()
{
    gcloud pubsub topics create $1
    gcloud pubsub subscriptions create --topic $1 $1
}

queue_post()
{
    gcloud pubsub topics publish $1 --attribute=CLONEURL=$2,COMMIT=$3
}

queue_recv()
{
    gcloud pubsub subscriptions pull $1 --auto-ack "--format=value(message.attributes)"
}
