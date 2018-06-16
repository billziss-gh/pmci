cd $(dirname "$0")

if [ ! -d functions-emulator ]; then
    mkdir functions-emulator
    npm install --prefix functions-emulator @google-cloud/functions-emulator
fi
