const ChluIPFS = require('chlu-ipfs-support')
const ChluAPIClient = require('chlu-api-client')
const ChluAPIQuery = require('chlu-api-query')
const ChluAPIPublish = require('chlu-api-publish')
const ChluCollector = require('chlu-collector')
const startMarketplace = require('chlu-marketplace-js/src/bin/serve.js')
const logger = require('chlu-ipfs-support/tests/utils/logger');
const { createIPFS } = require('chlu-ipfs-support/tests/utils/ipfs');
const { getFakeReviewRecord } = require('chlu-ipfs-support/tests/utils/protobuf');
const cryptoTestUtils = require('chlu-ipfs-support/tests/utils/crypto');
const fakeHttpModule = require('chlu-ipfs-support/tests/utils/http');
const btcUtils = require('chlu-ipfs-support/tests/utils/bitcoin');
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const expect = require('chai').expect
const { get } = require('lodash')
const sinon = require('sinon')

require('./index.js')

function getTestDir(name, date) {
    return path.join(os.tmpdir(), `chlu-integration-test-${date}`, name)
}

const marketplacePort = 3101

describe.only('Integration: API Client + ChluIPFS with Query+Publish API Servers and Collector', () => {

    let api, customer, vendor, publishServer, queryServer, collector, preparePoPR, vm, v, m, makeDID, mkt

    const verbose = false // set this to true to get all components to log debug strings

    before(async () => {
        const date = Date.now()
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
        customer = new ChluIPFS({
            directory: getTestDir('customer', date),
            logger: logger('Customer', verbose)
        })
        customer.ipfs = await createIPFS({
            repo: getTestDir('customer/ipfs', date)
        })
        vendor = new ChluIPFS({
            directory: getTestDir('vendor', date),
            logger: logger('Vendor', verbose)
        })
        vendor.ipfs = await createIPFS({
            repo: getTestDir('vendor/ipfs', date)
        })
        collector = new ChluIPFS({
            directory: getTestDir('collector', date),
            logger: logger('Collector', verbose)
        })
        collector.ipfs = await createIPFS({
            repo: getTestDir('collector/ipfs', date)
        })
        collector.collector = new ChluCollector(collector)

        const marketplace = await startMarketplace(marketplacePort, {
            marketplaceLocation: `http://localhost:${marketplacePort}`,
            chluIpfs: {
                network: 'experimental',
                directory: getTestDir('marketplace', date),
                logger: logger('Chlu Marketplace', verbose)
            },
            db: {
                password: 'test',
                storage: path.join(getTestDir('marketplace/db'), 'db.sqlite')
            },
            ipfs: await createIPFS({
                repo: getTestDir('marketplace/ipfs', date)
            })
        })
        mkt = marketplace.mkt

        // Spies and mocks
        sinon.spy(collector, 'pin') // Spy pinning activity of Collector

        // Set up mocks to make validator work
        const crypto = cryptoTestUtils(collector);
        const makeKeyPair = crypto.makeKeyPair;
        makeDID = crypto.makeDID
        preparePoPR = crypto.preparePoPR;
        vm = await makeKeyPair();
        v = await makeDID();
        m = await makeDID();
        const http = fakeHttpModule(() => ({ didId: m.publicDidDocument.id }));
        collector.http = http;
        customer.http = http;
        queryServer.chluIpfs.http = http;
        publishServer.chluIpfs.http = http;
        publishServer.chluIpfs.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        queryServer.chluIpfs.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        collector.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        customer.bitcoin.Blockcypher = btcUtils.BlockcypherMock;

        // Start modules
        await collector.collector.start()
        await collector.start()
        await queryServer.start()
        await publishServer.start()
        await api.start()
        await customer.start()
        await customer.importDID(await api.exportDID(), false)
        await vendor.start()

        await vendor.vendor.registerToMarketplace(`http://localhost:${marketplacePort}`)
        v = await vendor.exportDID()

        // Do some DID prework to make sure nodes have everything they need

        // Publish Vendor and Marketplace DIDs from service node
        await collector.didIpfsHelper.publish(v, false)
        await collector.didIpfsHelper.publish(m, false)
        // wait until API Client DID is replicated
        await queryServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        await customer.getDID(api.didIpfsHelper.didId, true)
        await publishServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        // wait for Publish and Query to have DIDs for vendor and marketplace
        await queryServer.chluIpfs.getDID(v.publicDidDocument.id, true)
        await queryServer.chluIpfs.getDID(m.publicDidDocument.id, true)
        await customer.getDID(v.publicDidDocument.id, true)
        await customer.getDID(m.publicDidDocument.id, true)
        await publishServer.chluIpfs.getDID(v.publicDidDocument.id, true)
        await publishServer.chluIpfs.getDID(m.publicDidDocument.id, true)
        // IMPORTANT note for the future: do not parallelize these operations,
        // it introduces some kind of OrbitDB bug where the tests fail intermittently
    })

    after(async () => {
        try {
            await collector.collector.stop()
            await api.stop()
            await customer.stop()
            await publishServer.stop()
            await queryServer.stop()
            await mkt.stop()
            await collector.stop()
        } catch(error){
            console.log(error)
        }
        cleanup()
    })

    function cleanup() {
        rimraf.sync(publishServer.chluIpfs.directory);
        rimraf.sync(collector.directory);
        rimraf.sync(queryServer.chluIpfs.directory);
        rimraf.sync(api.directory);
    }

    function setupBtcMock(multihash, rr) {
        // delete cached info, since we are about to change it
        collector.cache.cache.del(btcUtils.exampleTransaction.hash);
        customer.cache.cache.del(btcUtils.exampleTransaction.hash);
        publishServer.chluIpfs.cache.cache.del(btcUtils.exampleTransaction.hash);
        queryServer.chluIpfs.cache.cache.del(btcUtils.exampleTransaction.hash);
        // tell mock btc module to return a TX that matches the RR
        collector.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        customer.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        publishServer.chluIpfs.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        queryServer.chluIpfs.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
    }

    describe('API Client + Customer ChluIPFS with API Servers', () => {

        it('client DID generated when starting is published', async () => {
            expect(customer.didIpfsHelper.didId).to.equal(api.didIpfsHelper.didId)
            const didId = get(await api.exportDID(), 'publicDidDocument.id')
            // check that the publish server has it
            expect(get(await publishServer.chluIpfs.getDID(didId), 'id')).to.equal(didId)
            // check that the collector picks it up
            expect(get(await collector.getDID(didId, true), 'id')).to.equal(didId)
            // check that the query server picks it up too
            expect(get(await queryServer.chluIpfs.getDID(didId, true), 'id')).to.equal(didId)
        })

        it('ChluIPFS stores a verified review record, then API Client reads it', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Store the RR
            const multihash = await customer.storeReviewRecord(reviewRecord, {
                publish: false
            })
            // set up btc mock to return the right content
            setupBtcMock(multihash, reviewRecord);
            const multihash2 = await customer.storeReviewRecord(reviewRecord, {
                publish: true,
                bitcoinTransactionHash: 'fake',
                expectedMultihash: multihash
            })
            expect(multihash).to.equal(multihash2)
            // Check that it's present in the list for all three
            expect(await publishServer.chluIpfs.getReviewList()).to.contain(multihash)
            expect(await queryServer.chluIpfs.getReviewList()).to.contain(multihash)
            expect(await collector.getReviewList()).to.contain(multihash)
            // Check that the collector pinned it
            expect(collector.pin.calledWith(multihash)).to.be.true
            // Read it
            const readRecord = await api.readReviewRecord(multihash)
            expect(readRecord.requestedMultihash).to.equal(multihash)
            // Check that it was signed by the customer
            expect(readRecord.customer_signature.creator).to.equal(api.didIpfsHelper.didId)
            expect(readRecord.issuer_signature.creator).to.equal(api.didIpfsHelper.didId)
        })

        it('API Client publishes a DID, then reads it', async () => {
            const did = await makeDID()
            collector.didIpfsHelper.publish(did)
            const result = await api.getDID(did.publicDidDocument.id, true)
            expect(result).to.deep.equal(did.publicDidDocument)
        })

        it('ChluIPFS publishes a review, then API Client reads review records by author', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Store the RR
            const multihash = await customer.storeReviewRecord(reviewRecord, {
                publish: false
            })
            // set up btc mock to return the right content
            setupBtcMock(multihash, reviewRecord);
            // Publish it using the Publish Server
            await customer.storeReviewRecord(reviewRecord, {
                publish: true,
                bitcoinTransactionHash: 'fake',
                expectedMultihash: multihash
            })
            // Read it from Query Server
            const rr = await queryServer.chluIpfs.readReviewRecord(multihash)
            // Make sure customer signature is correct
            expect(rr.customer_signature.creator).to.equal(api.didIpfsHelper.didId)
            // Check reviews by author
            let reviewsByAuthor
            do {
                // It might not be correct right away, need to wait for orbit-db to replicate
                reviewsByAuthor = await api.getReviewsWrittenByDID(api.didIpfsHelper.didId)
                if (reviewsByAuthor.length < 1) await waitMs(1000)
            } while(reviewsByAuthor.length < 1)
            expect(reviewsByAuthor).to.contain(multihash)
        })

        it('ChluIPFS publishes a review, then API Client reads review records by subject', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Store the RR
            const multihash = await customer.storeReviewRecord(reviewRecord, {
                publish: false
            })
            // set up btc mock to return the right content
            setupBtcMock(multihash, reviewRecord);
            // Publish it using the Publish Server
            await customer.storeReviewRecord(reviewRecord, {
                publish: true,
                bitcoinTransactionHash: 'fake',
                expectedMultihash: multihash
            })
            // Read it from Query Server
            const rr = await queryServer.chluIpfs.readReviewRecord(multihash)
            // Make sure Subject DID is correct
            expect(rr.popr.vendor_did).to.equal(v.publicDidDocument.id)
            // Check reviews by author
            let reviewsBySubject
            do {
                // It might not be correct right away, need to wait for orbit-db to replicate
                reviewsBySubject = await api.getReviewsAboutDID(v.publicDidDocument.id)
                if (reviewsBySubject.length < 1) await waitMs(1000)
            } while(reviewsBySubject.length < 1)
            expect(reviewsBySubject).to.contain(multihash)

        })
    })

    describe('API Client and Marketplace', () => {
        it('API Client registers as Vendor', async () => {
            const vendorData = await mkt.getVendor(vendor.didIpfsHelper.didId)
            expect(vendorData.vDidId).to.equal(vendor.didIpfsHelper.didId)
            expect(vendorData.vSignature).to.be.a('string')
        })
    })
})

async function waitMs(x) {
    return new Promise(resolve =>  setTimeout(resolve, x))
}