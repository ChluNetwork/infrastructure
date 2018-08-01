const expect = require('chai').expect;

const ChluIPFS = require('chlu-ipfs-support');
const ChluCollector = require('chlu-collector')
// Test utilities
const { getFakeReviewRecord, makeUnverified } = require('chlu-ipfs-support/tests/utils/protobuf');
const utils = require('chlu-ipfs-support/tests/utils/ipfs');
const env = require('chlu-ipfs-support/src/utils/env');
const logger = require('chlu-ipfs-support/tests/utils/logger');
const cryptoTestUtils = require('chlu-ipfs-support/tests/utils/crypto');
const fakeHttpModule = require('chlu-ipfs-support/tests/utils/http');
const btcUtils = require('chlu-ipfs-support/tests/utils/bitcoin');
// Libs
const { cloneDeep } = require('lodash');
const rimraf = require('rimraf');
const sinon = require('sinon');

function withoutHashAndSig(obj) {
    return Object.assign({}, obj, {
        sig: null,
        hash: ''
    });
}

function strip(obj) {
    delete obj.gotLatestVersion;
    delete obj.multihash;
    delete obj.requestedMultihhash;
    delete obj.editable;
    delete obj.watching;
}

describe('Integration: Chlu Collector and Review Records', function() {
    let server, testDir, ipfsDir, customerNode, customerIpfs, serviceNode, serviceIpfs;
    let v, vm, m, preparePoPR;

    before(async () => {
        if (env.isNode()) {
            server = await require('chlu-collector/src/rendezvous').startRendezvousServer(ChluIPFS.rendezvousPorts.test);
        }

        ipfsDir = env.isNode() ? '/tmp/chlu-test-ipfs-' + Date.now() + Math.random() + '/' : Date.now() + Math.random();
        serviceIpfs = await utils.createIPFS({ repo: ipfsDir + '/' + 'service' });
        customerIpfs = await utils.createIPFS({ repo: ipfsDir + '/' + 'customer' });

        // Connect the peers manually to speed up test times
        // await utils.connect(serviceNode.ipfs, customerNode.ipfs);

        testDir = env.isNode() ? '/tmp/chlu-test-' + Date.now() + Math.random() + '/' : Date.now() + Math.random();

        const serviceNodeDir = testDir + 'chlu-service-node';
        const customerDir = testDir + 'chlu-customer';

        serviceNode = new ChluIPFS({
            logger: logger('Service'),
            directory: serviceNodeDir,
            enablePersistence: false,
            bootstrap: false
        });
        serviceNode.collector = new ChluCollector(serviceNode)
        customerNode = new ChluIPFS({
            logger: logger('Customer'),
            directory: customerDir,
            enablePersistence: false,
            bootstrap: false
        });
        // Make sure they don't connect to production
        expect(customerNode.network).to.equal(ChluIPFS.networks.experimental);
        expect(serviceNode.network).to.equal(ChluIPFS.networks.experimental);

        serviceNode.ipfs = serviceIpfs;
        customerNode.ipfs = customerIpfs;

        // Spies
        sinon.spy(serviceNode.pinning, 'pin');
    
        // Stubs
        const crypto = cryptoTestUtils(serviceNode);
        const makeKeyPair = crypto.makeKeyPair;
        const makeDID = crypto.makeDID
        preparePoPR = crypto.preparePoPR;
        vm = await makeKeyPair();
        v = await makeDID();
        m = await makeDID();
        const http = fakeHttpModule(() => ({ didId: m.publicDidDocument.id }));
        serviceNode.http = http;
        customerNode.http = http;
        serviceNode.ipfsUtils.stop = sinon.stub().resolves();
        customerNode.ipfsUtils.stop = sinon.stub().resolves();
        serviceNode.bitcoin.Blockcypher = btcUtils.BlockcypherMock;
        customerNode.bitcoin.Blockcypher = btcUtils.BlockcypherMock;

        // Start nodes
        await Promise.all([serviceNode.start(), customerNode.start()]);
        await serviceNode.collector.start()

        // Do some DID prework to make sure nodes have everything they need

        // Publish Vendor and Marketplace DIDs from service node
        await serviceNode.didIpfsHelper.publish(v, false)
        await serviceNode.didIpfsHelper.publish(m, false)
        // wait until Customer DID is replicated into Service Node's OrbitDB
        await serviceNode.orbitDb.getDID(customerNode.didIpfsHelper.didId, true)
        // wait for customer node to have DIDs for vendor and marketplace
        await customerNode.orbitDb.getDID(v.publicDidDocument.id, true)
        await customerNode.orbitDb.getDID(m.publicDidDocument.id, true)
        // IMPORTANT note for the future: do not parallelize these operations,
        // it introduces some kind of OrbitDB bug where the tests fail intermittently
    });

    after(async () => {
        await serviceNode.collector.stop()
        await Promise.all([serviceNode.stop(), customerNode.stop()]);
        if (env.isNode()) {
            await server.stop();
            rimraf.sync(testDir);
        }
    });

    function setupBtcMock(multihash, rr) {
        // delete cached info, since we are about to change it
        serviceNode.cache.cache.del(btcUtils.exampleTransaction.hash);
        customerNode.cache.cache.del(btcUtils.exampleTransaction.hash);
        // tell mock btc module to return a TX that matches the RR
        serviceNode.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
        customerNode.bitcoin.api.returnMatchingTXForRR(Object.assign({}, rr, { multihash }));
    }

    it('handles Unverified Reviews', async () => {
        // Create fake review record
        let reviewRecord = makeUnverified(await getFakeReviewRecord())
        // import reviews and await for completion
        const reviews = [reviewRecord]
        const [hash] = await customerNode.reviewRecords.importUnverifiedReviews(reviews)
        const customerRecord = await customerNode.readReviewRecord(hash);
        expect(customerRecord.editable).to.be.false;
        // check hash validity
        expect(hash).to.be.a('string').that.is.not.empty;
        // the service node should already have pinned the hash
        expect(serviceNode.pinning.pin.calledWith(hash)).to.be.true;
        // check that reading works
        const readRecord = await serviceNode.readReviewRecord(hash);
        expect(readRecord.editable).to.be.false;
        expect(strip(readRecord)).to.deep.equal(strip(customerRecord));
        // check orbit-db did indexing
        expect(await serviceNode.orbitDb.getReviewsAboutDID(readRecord.subject.did))
            .to.contain(hash)
    })

    it('handles Verified Reviews', async () => {
        // Create fake review record
        let reviewRecord = await getFakeReviewRecord();
        reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
        // store review record and await for completion
        const hash = await customerNode.storeReviewRecord(reviewRecord, {
            publish: false
        });
        // set up btc mock to return the right content
        setupBtcMock(hash, reviewRecord);
        // publish
        await customerNode.storeReviewRecord(reviewRecord, {
            bitcoinTransactionHash: btcUtils.exampleTransaction.hash
        });
        const customerRecord = await customerNode.readReviewRecord(hash);
        expect(customerRecord.editable).to.be.true;
        // check hash validity
        expect(hash).to.be.a('string').that.is.not.empty;
        // the service node should already have pinned the hash
        expect(serviceNode.pinning.pin.calledWith(hash)).to.be.true;
        // check that reading works
        const readRecord = await serviceNode.readReviewRecord(hash);
        expect(readRecord.editable).to.be.false;
        expect(strip(readRecord)).to.deep.equal(strip(customerRecord));
        // check orbit-db by did indexing
        expect(await serviceNode.orbitDb.getReviewsWrittenByDID(readRecord.customer_signature.creator))
            .to.contain(hash)
        expect(await serviceNode.orbitDb.getReviewsAboutDID(readRecord.popr.vendor_did))
            .to.contain(hash)
    });

    describe('Verified Review Updates', () => {

        it('handles updates', async () => {
            // Create fake review record
            let reviewRecord = await getFakeReviewRecord();
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Now create a fake update
            let reviewUpdate = await getFakeReviewRecord();
            reviewUpdate.popr = cloneDeep(reviewRecord.popr);
            reviewUpdate.review_text = 'Actually it broke after just a week!';
            reviewUpdate.rating = 1;
            // Store the original review
            const multihash = await customerNode.storeReviewRecord(reviewRecord, {
                publish: false
            });
            setupBtcMock(multihash, reviewRecord);
            await customerNode.storeReviewRecord(reviewRecord, {
                bitcoinTransactionHash: btcUtils.exampleTransaction.hash
            });
            // Check that the review list is updated
            expect((await customerNode.orbitDb.getReviewRecordList())[0]).to.equal(multihash);
            // Store the update
            reviewUpdate.previous_version_multihash = multihash
            const updatedMultihash = await customerNode.storeReviewRecord(reviewUpdate);
            const rr = await serviceNode.readReviewRecord(multihash, { getLatestVersion: true });
            const rrUpdate = await serviceNode.readReviewRecord(updatedMultihash);
            expect(strip(rr)).to.deep.equal(strip(rrUpdate));
        });

        it('handles updates happening after a read', async () => {
            await new Promise(async (resolve, reject) => {
                // Create fake review record
                let reviewRecord = await getFakeReviewRecord();
                reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
                // Store the original review
                const multihash = await customerNode.storeReviewRecord(reviewRecord, {
                    publish: false
                });
                setupBtcMock(multihash, reviewRecord);
                await customerNode.storeReviewRecord(reviewRecord, {
                    bitcoinTransactionHash: btcUtils.exampleTransaction.hash
                });
                // Now try to fetch it from the service node while checking for updates
                const notifyUpdate = async (originalHash, newHash, rr) => {
                    try {
                        expect(newHash).to.not.equal(multihash);
                        expect(originalHash).to.equal(multihash);
                        expect(withoutHashAndSig(rr)).to.not.deep.equal(reviewRecord);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                };
                serviceNode.events.once('reviewrecord/updated', notifyUpdate);
                await serviceNode.readReviewRecord(multihash, { checkForUpdates: true });
                // Now create a fake update
                let reviewUpdate = await getFakeReviewRecord();
                reviewUpdate.previous_version_multihash = multihash
                reviewUpdate.popr = cloneDeep(reviewRecord.popr);
                reviewUpdate.review_text = 'Actually it broke after just a week!';
                reviewUpdate.rating = 1;
                // Store the update
                await customerNode.storeReviewRecord(reviewUpdate);
            });
        });

        it('handles updates written by the current node', async () => {
            // Create fake review record
            let reviewRecord = await getFakeReviewRecord();
            reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
            // Now create a fake update
            let reviewUpdate = await getFakeReviewRecord();
            reviewUpdate.popr = cloneDeep(reviewRecord.popr);
            reviewUpdate.review_text = 'Actually it broke after just a week!';
            reviewUpdate.rating = 1;
            // Store the original review
            const multihash = await customerNode.storeReviewRecord(reviewRecord, {
                publish: false
            });
            setupBtcMock(multihash, reviewRecord);
            await customerNode.storeReviewRecord(reviewRecord, {
                bitcoinTransactionHash: btcUtils.exampleTransaction.hash
            });
            // Store the update
            reviewUpdate.previous_version_multihash = multihash
            const updatedMultihash = await customerNode.storeReviewRecord(reviewUpdate);
            const rr = await customerNode.readReviewRecord(multihash, { getLatestVersion: true });
            const rrUpdate = await customerNode.readReviewRecord(updatedMultihash);
            expect(strip(rrUpdate)).to.deep.equal(strip(rr));
        });

        it('handles updates after the read, written by the current node', async () => {
            await new Promise(async (resolve, reject) => {
                // Create fake review record
                let reviewRecord = await getFakeReviewRecord();
                reviewRecord.popr = await preparePoPR(reviewRecord.popr, vm, v, m);
                // Store the original review
                const multihash = await customerNode.storeReviewRecord(reviewRecord, {
                    publish: false
                });
                setupBtcMock(multihash, reviewRecord);
                await customerNode.storeReviewRecord(reviewRecord, {
                    bitcoinTransactionHash: btcUtils.exampleTransaction.hash
                });
                // Now try to fetch it from the customer node while checking for updates
                const notifyUpdate = async (originalHash, newHash, rr) => {
                    try {
                        expect(newHash).to.not.equal(multihash);
                        expect(originalHash).to.equal(multihash);
                        expect(rr.previous_version_multihash).to.equal(originalHash);
                        const customerUpdate = await customerNode.readReviewRecord(newHash);
                        expect(strip(rr)).to.deep.equal(strip(customerUpdate));
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                };
                customerNode.events.once('reviewrecord/updated', notifyUpdate);
                await customerNode.readReviewRecord(multihash, { checkForUpdates: true });
                // Now create a fake update
                let reviewUpdate = await getFakeReviewRecord();
                reviewUpdate.previous_version_multihash = multihash
                reviewUpdate.popr = cloneDeep(reviewRecord.popr);
                reviewUpdate.review_text = 'Actually it broke after just a week!';
                reviewUpdate.rating = 1;
                // Store the update
                await customerNode.storeReviewRecord(reviewUpdate);
            });
        });
    })
});
