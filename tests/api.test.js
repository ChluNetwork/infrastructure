const ChluIPFS = require('chlu-ipfs-support')
const ChluAPIClient = require('chlu-api-client')
const ChluAPIQuery = require('chlu-api-query')
const ChluAPIPublish = require('chlu-api-publish')
const ChluCollector = require('chlu-collector')
const logger = require('chlu-ipfs-support/tests/utils/logger');
const { startRendezvousServer } = require('chlu-collector/src/rendezvous')
const { createIPFS } = require('chlu-ipfs-support/tests/utils/ipfs');
const { getFakeReviewRecord, makeUnverified } = require('chlu-ipfs-support/tests/utils/protobuf');
const cryptoTestUtils = require('chlu-ipfs-support/tests/utils/crypto');
const fakeHttpModule = require('chlu-ipfs-support/tests/utils/http');
const btcUtils = require('chlu-ipfs-support/tests/utils/bitcoin');
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const expect = require('chai').expect
const { get } = require('lodash')
const sinon = require('sinon')

function getTestDir(name, date) {
    return path.join(os.tmpdir(), `chlu-integration-test-${date}`, name)
}

describe('Integration: API Client with Query and Publish API Servers and Collector', () => {

    let api, publishServer, queryServer, rendezvous, vm, v, m

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
        // Spies and mocks
        sinon.spy(collector, 'pin') // Spy pinning activity of Collector

        // Set up mocks to make validator work
        const crypto = cryptoTestUtils(collector);
        const makeKeyPair = crypto.makeKeyPair;
        const makeDID = crypto.makeDID
        preparePoPR = crypto.preparePoPR;
        vm = await makeKeyPair();
        v = await makeDID();
        m = await makeDID();
        const http = fakeHttpModule(() => ({ didId: m.publicDidDocument.id }));
        collector.http = http;
        queryServer.chluIpfs.http = http;
        publishServer.chluIpfs.http = http;
        publishServer.chluIpfs.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        queryServer.chluIpfs.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        collector.bitcoin.Blockcypher = btcUtils.BlockcypherMock;

        // Start modules
        await collector.collector.start()
        await collector.start()
        await queryServer.start()
        await publishServer.start()
        await api.start()

        // Do some DID prework to make sure nodes have everything they need

        // Publish Vendor and Marketplace DIDs from service node
        await collector.didIpfsHelper.publish(v, false)
        await collector.didIpfsHelper.publish(m, false)
        // wait until API Client DID is replicated
        await queryServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        await publishServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        // wait for Publish and Query to have DIDs for vendor and marketplace
        await queryServer.chluIpfs.getDID(v.publicDidDocument.id, true)
        await publishServer.chluIpfs.getDID(m.publicDidDocument.id, true)
        // IMPORTANT note for the future: do not parallelize these operations,
        // it introduces some kind of OrbitDB bug where the tests fail intermittently
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

    function setupBtcMock(multihash, rr) {
        // delete cached info, since we are about to change it
        collector.cache.cache.del(btcUtils.exampleTransaction.hash);
        publishServer.chluIpfs.cache.cache.del(btcUtils.exampleTransaction.hash);
        queryServer.chluIpfs.cache.cache.del(btcUtils.exampleTransaction.hash);
        // tell mock btc module to return a TX that matches the RR
        collector.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        publishServer.chluIpfs.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        queryServer.chluIpfs.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
    }

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

        it('stores a verified review record', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Store the RR
            const multihash = await api.storeReviewRecord(reviewRecord, {
                publish: false
            })
            // set up btc mock to return the right content
            setupBtcMock(multihash, reviewRecord);
            await api.storeReviewRecord(reviewRecord, {
                publish: true,
                bitcoinTransactionHash: 'fake',
                expectedMultihash: multihash
            })
            // Check that it's present in the list for all three
            expect(await publishServer.chluIpfs.getReviewList()).to.contain(multihash)
            expect(await queryServer.chluIpfs.getReviewList()).to.contain(multihash)
            expect(await collector.getReviewList()).to.contain(multihash)
            // Check that the collector pinned it
            expect(collector.pin.calledWith(multihash)).to.be.true
            // Read it
            const readRecord = await api.readReviewRecord(multihash)
            expect(readRecord.requestedMultihash).to.equal(multihash)
        })

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