const ChluIPFS = require('chlu-ipfs-support');
const { startRendezvousServer } = require('chlu-collector/src/rendezvous')
const env = require('node-env-file')
const path = require('path')

let server

before(async () => {
    process.env.DISABLE_LOGS = '1'
    env(path.join(__dirname, '..', '.env'))
    server = await startRendezvousServer(ChluIPFS.rendezvousPorts.test);
})

after(async () => {
    await server.stop()
})