# startx.sh

exec >>/var/log/startx.log
exec 2>&1

echo ">>>>STARTX `date +%Y-%m-%dT%H:%M:%S%z`"
trap 'set +ex; echo "<<<<STARTX `date +%Y-%m-%dT%H:%M:%S%z`"' EXIT
set -ex

if [ -e /firstboot ]; then
    grep -q clear_tmp_enable /etc/rc.conf || echo 'clear_tmp_enable="YES"' >>/etc/rc.conf

    # upgrade: cloud sdk; see https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=225255
    pkg delete -y google-cloud-sdk
    rm -rf /usr/local/google-cloud-sdk/
    pkg install -y google-cloud-sdk
    # gcloud components update

    # install: base packages
    pkg install -y git
    pkg install -y go

    # install: build custom Go
    # (fixes signal handling bug; remove when Go 1.11 is available)
    if [ ! -x /usr/local/go-custom/bin/go ]; then
        git clone --depth 50 https://github.com/golang/go.git /usr/local/go-custom
        (export GOROOT_BOOTSTRAP=/usr/local/go && cd /usr/local/go-custom/src && ./make.bash)
    fi
else
    # use custom Go
    export GOROOT=/usr/local/go-custom
    export PATH=/usr/local/go-custom/bin:$PATH

    # clone repo and build
    mkdir -p /tmp/repo
    cd /tmp/repo
    builder_build work
fi
