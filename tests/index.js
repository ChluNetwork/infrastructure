const ChluIPFS = require('chlu-ipfs-support');
const { startRendezvousServer } = require('chlu-collector/src/rendezvous')

let server

before(async () => {
    process.env.DISABLE_LOGS = '1'
    server = await startRendezvousServer(ChluIPFS.rendezvousPorts.test);
})

after(async () => {
    await server.stop()
})