const ChluIPFS = require('chlu-ipfs-support')
const ChluSQLIndex = require('chlu-ipfs-support/src/modules/orbitdb/indexes/sql')
const ChluAPIClient = require('chlu-api-client')
const ChluAPIQuery = require('chlu-api-query')
const ChluAPIPublish = require('chlu-api-publish')
const ChluCollector = require('chlu-collector')
const startMarketplace = require('chlu-marketplace-js/src/bin/serve.js')
const logger = require('chlu-ipfs-support/tests/utils/logger');
const { createIPFS } = require('chlu-ipfs-support/tests/utils/ipfs');
const { getFakeReviewRecord } = require('chlu-ipfs-support/tests/utils/protobuf');
const btcUtils = require('chlu-ipfs-support/tests/utils/bitcoin');
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const expect = require('chai').expect
const { get, cloneDeep } = require('lodash')
const sinon = require('sinon')

require('./index.js')

function getTestDir(name, date) {
    return path.join(os.tmpdir(), `chlu-integration-test-${date}`, name)
}

const marketplacePort = 3101

describe('Integration: API Client + ChluIPFS with Query+Publish API Servers and Collector', () => {

    let api, customer, vendor, publishServer, queryServer, collector, mkt

    const verbose = false // set this to true to get all components to log debug strings
    const enableLogs = false // set this to true to turn on test-specific logs

    const log = x => { if (enableLogs) console.log('[TEST]', x) }

    before(async () => {
        const date = Date.now()
        // Use custom port so it does not conflict
        const queryPort = 3105
        const publishPort = 3106
        // Prepare PostgreSQL config
        const OrbitDBIndex = ChluSQLIndex
        const dbName = process.env.CHLU_POSTGRESQL_DB
        const dbHost = process.env.CHLU_DATABASE_HOST || 'localhost'
        const dbPort = process.env.CHLU_DATABASE_PORT || 5432
        const dbUser = process.env.CHLU_POSTGRESQL_USER
        const dbPassword = process.env.CHLU_POSTGRESQL_PASSWORD
        const OrbitDBIndexOptions = {
            host: dbHost,
            port: dbPort,
            enableValidations: false,
            enableWrites: false,
            dialect: 'postgres',
            database: dbName,
            username: dbUser,
            password: dbPassword,
        }
        // Prepare Services
        queryServer = new ChluAPIQuery({
            port: queryPort,
            logger: logger('Query', verbose),
            chluIpfsConfig: {
                directory: getTestDir('query-server', date),
                logger: logger('Query', verbose),
                OrbitDBIndex,
                OrbitDBIndexOptions
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
                logger: logger('Query', verbose),
                OrbitDBIndex,
                OrbitDBIndexOptions
            }
        })
        publishServer.chluIpfs.ipfs = await createIPFS({
            repo: getTestDir('publish-server/ipfs', date)
        })
        api = new ChluAPIClient({
            publishApiUrl: `http://localhost:${publishPort}`,
            queryApiUrl: `http://localhost:${queryPort}`,
            directory: getTestDir('customer-api-client', date),
            logger: logger('Client', verbose),
        })
        customer = new ChluIPFS({
            directory: getTestDir('customer', date),
            logger: logger('Customer', verbose),
            // TODO: can't use Noop index: we require full index for publishing
        })
        customer.ipfs = await createIPFS({
            repo: getTestDir('customer/ipfs', date)
        })
        vendor = new ChluAPIClient({
            publishApiUrl: `http://localhost:${publishPort}`,
            queryApiUrl: `http://localhost:${queryPort}`,
            directory: getTestDir('vendor-api-client', date),
            logger: logger('Vendor', verbose)
        })
        collector = new ChluIPFS({
            directory: getTestDir('collector', date),
            logger: logger('Collector', verbose),
            OrbitDBIndex,
            OrbitDBIndexOptions: Object.assign(cloneDeep(OrbitDBIndexOptions), {
                enableWrites: true,
                enableValidations: true,
                clearOnStart: true
            })
        })
        collector.ipfs = await createIPFS({
            repo: getTestDir('collector/ipfs', date)
        })
        collector.collector = new ChluCollector(collector)

        const marketplace = await startMarketplace(marketplacePort, {
            marketplaceLocation: `http://localhost:${marketplacePort}`,
            logger: logger('Chlu Marketplace', verbose),
            chluIpfs: {
                network: 'experimental',
                directory: getTestDir('marketplace', date),
                OrbitDBIndex,
                OrbitDBIndexOptions
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
        customer.didIpfsHelper.didToImport = await api.exportDID()
        await customer.start()
        await vendor.start()

        // Log DIDs
        log('Collector DID', get(await collector.exportDID(), 'publicDidDocument.id'))
        log('Query Server DID', get(await queryServer.chluIpfs.exportDID(), 'publicDidDocument.id'))
        log('Publish Server DID', get(await publishServer.chluIpfs.exportDID(), 'publicDidDocument.id'))
        log('Marketplace DID', get(await mkt.chluIpfs.exportDID(), 'publicDidDocument.id'))
        log('API Client DID', get(await api.exportDID(), 'publicDidDocument.id'))
        log('Customer DID', get(await customer.exportDID(), 'publicDidDocument.id'))
        log('Vendor DID', get(await vendor.exportDID(), 'publicDidDocument.id'))

        const v = await vendor.exportDID()
        const m = await mkt.chluIpfs.exportDID()

        await collector.getDID(m.publicDidDocument.id, true)
        log(m.publicDidDocument.id, 'Collector OK')
        await collector.getDID(v.publicDidDocument.id, true)
        log(v.publicDidDocument.id, 'Collector OK')
        await mkt.chluIpfs.getDID(v.publicDidDocument.id, true)
        log(v.publicDidDocument.id, 'Marketplace OK')

        await vendor.registerToMarketplace(`http://localhost:${marketplacePort}`)

        // Do some DID prework to make sure nodes have everything they need

        // wait until API Client DID is replicated
        await queryServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        log(api.didIpfsHelper.didId, 'Query OK')
        await customer.getDID(api.didIpfsHelper.didId, true)
        log(api.didIpfsHelper.didId, 'Customer OK')
        await publishServer.chluIpfs.getDID(api.didIpfsHelper.didId, true)
        log(api.didIpfsHelper.didId, 'Publish OK')
        // wait for Publish and Query to have DIDs for vendor and marketplace
        await queryServer.chluIpfs.getDID(v.publicDidDocument.id, true)
        log(v.publicDidDocument.id, 'Query OK')
        await queryServer.chluIpfs.getDID(m.publicDidDocument.id, true)
        log(m.publicDidDocument.id, 'Query OK')
        await customer.getDID(v.publicDidDocument.id, true)
        log(v.publicDidDocument.id, 'Customer OK')
        await customer.getDID(m.publicDidDocument.id, true)
        log(m.publicDidDocument.id, 'Customer OK')
        await publishServer.chluIpfs.getDID(v.publicDidDocument.id, true)
        log(v.publicDidDocument.id, 'Publish OK')
        await publishServer.chluIpfs.getDID(m.publicDidDocument.id, true)
        log(m.publicDidDocument.id, 'Publish OK')
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

    async function preparePoPR(poprData) {
        const vendorId = vendor.didIpfsHelper.didId
        const { popr } = await mkt.createPoPR(vendorId, poprData)
        expect(popr.marketplace_url).to.equal(`http://localhost:${marketplacePort}`)
        return popr
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
            reviewRecord.popr = await preparePoPR(reviewRecord.popr);
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
            expect((await publishServer.chluIpfs.getReviewList()).map(x => x.multihash)).to.contain(multihash)
            expect((await queryServer.chluIpfs.getReviewList()).map(x => x.multihash)).to.contain(multihash)
            expect((await collector.getReviewList()).map(x => x.multihash)).to.contain(multihash)
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
            const did = await api.didIpfsHelper.chluDID.generateDID()
            collector.didIpfsHelper.publish(did)
            const result = await api.getDID(did.publicDidDocument.id, true)
            expect(result).to.deep.equal(did.publicDidDocument)
        })

        it('ChluIPFS publishes a review, then API Client reads review records by author', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr);
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
            expect(reviewsByAuthor.map(x => x.multihash)).to.contain(multihash)
        })

        it('ChluIPFS publishes a review, then API Client reads review records by subject', async () => {
            const reviewRecord = await getFakeReviewRecord()
            reviewRecord.popr = await preparePoPR(reviewRecord.popr);
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
            expect(rr.popr.vendor_did).to.equal(vendor.didIpfsHelper.didId)
            // Check reviews by author
            let reviewsBySubject
            do {
                // It might not be correct right away, need to wait for orbit-db to replicate
                reviewsBySubject = await api.getReviewsAboutDID(vendor.didIpfsHelper.didId)
                if (reviewsBySubject.length < 1) await waitMs(1000)
            } while(reviewsBySubject.length < 1)
            expect(reviewsBySubject.map(x => x.multihash)).to.contain(multihash)

        })
    })

    describe('API Client and Marketplace', () => {
        it('API Client registers as Vendor', async () => {
            const vendorData = await mkt.getVendor(vendor.didIpfsHelper.didId)
            expect(vendorData.vDidId).to.equal(vendor.didIpfsHelper.didId)
            expect(vendorData.vSignature).to.be.a('string')
        })

        it('API Client updates own Vendor profile on marketplace')
    })
})

async function waitMs(x) {
    return new Promise(resolve =>  setTimeout(resolve, x))
}