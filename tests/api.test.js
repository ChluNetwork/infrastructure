const ChluIPFS = require('chlu-ipfs-support')
const ChluAPIClient = require('chlu-api-client')
const ChluAPIQuery = require('chlu-api-query')
const ChluAPIPublish = require('chlu-api-publish')
const ChluCollector = require('chlu-collector')
const logger = require('chlu-ipfs-support/tests/utils/logger');
const { startRendezvousServer } = require('chlu-collector/src/rendezvous')
const { createIPFS } = require('chlu-ipfs-support/tests/utils/ipfs');
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const expect = require('chai').expect
const { get } = require('lodash')

function getTestDir(name, date) {
    return path.join(os.tmpdir(), `chlu-integration-test-${date}`, name)
}

describe('Integration: API Client with Query and Publish API Servers and Collector', () => {

    let api, publishServer, queryServer, rendezvous

    const verbose = false // set this to true to get all components to log debug strings

    before(async () => {
        const date = Date.now()
        rendezvous = await startRendezvousServer(ChluIPFS.rendezvousPorts.test);
        // Use custom port so it does not conflict
        const queryPort = 3105
        const publishPort = 3106
        queryServer = new ChluAPIQuery({
            port: queryPort,
            logger: logger('Query', verbose),
            chluIpfsConfig: {
                directory: getTestDir('query-server', date),
                logger: logger('Query', verbose)
            }
        })
        queryServer.chluIpfs.ipfs = await createIPFS({
            repo: getTestDir('query-server/ipfs', date)
        })
        publishServer = new ChluAPIPublish({
            port: publishPort,
            logger: logger('Publish', verbose),
            chluIpfsConfig: {
                directory: getTestDir('publish-server', date),
                logger: logger('Query', verbose)
            }
        })
        publishServer.chluIpfs.ipfs = await createIPFS({
            repo: getTestDir('publish-server/ipfs', date)
        })
        api = new ChluAPIClient({
            publishApiUrl: `http://localhost:${publishPort}`,
            queryApiUrl: `http://localhost:${queryPort}`,
            directory: getTestDir('api-client', date),
            logger: logger('Client', verbose),
        })
        collector = new ChluIPFS({
            directory: getTestDir('collector', date),
            logger: logger('Collector', verbose)
        })
        collector.ipfs = await createIPFS({
            repo: getTestDir('collector/ipfs', date)
        })
        collector.collector = new ChluCollector(collector)
        // Start modules
        await collector.collector.start()
        await collector.start()
        await queryServer.start()
        await publishServer.start()
        await api.start()
    })

    after(async () => {
        await collector.collector.stop()
        await Promise.all([api.stop(), publishServer.stop(), queryServer.stop(), collector.stop()]);
        await rendezvous.stop();
        rimraf.sync(publishServer.chluIpfs.directory);
        rimraf.sync(collector.directory);
        rimraf.sync(queryServer.chluIpfs.directory);
        rimraf.sync(api.directory);
    })

    describe('API Client with Publish API Server', () => {
        it('client DID generated when starting is available', async () => {
            const didId = get(await api.exportDID(), 'publicDidDocument.id')
            // check that the publish server has it
            expect(get(await publishServer.chluIpfs.getDID(didId), 'id')).to.equal(didId)
            // check that the collector picks it up
            expect(get(await collector.getDID(didId, true), 'id')).to.equal(didId)
            // check that the query server picks it up too
            expect(get(await queryServer.chluIpfs.getDID(didId, true), 'id')).to.equal(didId)
        })
        it('stores a review record')
        it('publishes a DID')
    })

    describe('API Client with Query API Server', () => {
        it('reads a DID')
        it('reads a review records')
        it('reads review records by author')
        it('reads review records by subject')
    })

    describe('API Client and Marketplace', () => {
        it('registers as Vendor')
    })
})