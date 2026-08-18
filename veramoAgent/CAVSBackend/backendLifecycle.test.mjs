import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const {
    closeRegistryProvider,
    readOracleRegistry,
    withRegistryTimeout,
} = await import(`./ocrOracleRegistry.js?lifecycle-test=${Date.now()}`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('registry oracle details are read concurrently', async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    const provider = {
        getNetwork: async () => ({ chainId: 31337n }),
    };
    const contract = {
        oracleCount: async () => 3n,
        registeredOracleCount: async () => 3n,
        getRegisteredOracleIds: async () => [0n, 1n, 2n],
        getOracle: async (oracleId) => {
            activeReads += 1;
            maximumActiveReads = Math.max(maximumActiveReads, activeReads);
            await delay(20);
            activeReads -= 1;
            return {
                oracleId,
                account: '0x0000000000000000000000000000000000000001',
                did: `did:example:${oracleId}`,
                oraclesEncryptionKey: `0x${'01'.repeat(32)}`,
                active: true,
                updatedAt: 1n,
            };
        },
    };

    const registry = await readOracleRegistry(provider, contract, contract.account);

    assert.equal(maximumActiveReads, 3);
    assert.deepEqual(registry.registeredOracleIds, [0, 1, 2]);
    assert.equal(registry.oracles.length, 3);
});

test('registry provider cleanup calls destroy exactly once', async () => {
    let calls = 0;
    await closeRegistryProvider({
        destroy: async () => {
            calls += 1;
        },
    });
    assert.equal(calls, 1);
});

test('registry receipt wait has a bounded timeout', async () => {
    await assert.rejects(
        withRegistryTimeout(new Promise(() => {}), 10, 'receipt'),
        /receipt timed out after 10ms/,
    );
});

test('CAVS request lifecycle uses bounded and body-safe paths', () => {
    const source = fs.readFileSync(new URL('./CAVSService.js', import.meta.url), 'utf8');

    assert.match(
        source,
        /axios\.post\(\s*`\$\{veramoAgentEndpoint\}\/decode_jwt`,\s*\{ jwt \}/,
    );
    assert.doesNotMatch(source, /decode_jwt\?jwt=/);
    assert.match(source, /await ensureSelectedDidOnce\(\)/);
    assert.match(source, /OCR_REQUESTER_CALLBACK_TIMEOUT_MS/);
    assert.match(source, /OCR_VC_CALLBACK_TIMEOUT_MS/);
    assert.match(source, /CAVS_COMPETENCE_TIMEOUT_MS \|\| '220000'/);
    assert.match(source, /timeout: competenceCheckerRequestTimeoutMs/);
    assert.doesNotMatch(source, /timeout: 120000/);
    assert.match(source, /OCR_MAX_REMOTE_ENDPOINTS/);
    assert.match(source, /OCR_MAX_VC_SIGNERS/);
    assert.doesNotMatch(source, /ocrFinalVcByRequestId/);
    assert.doesNotMatch(source, /timer\.unref/);
    assert.match(source, /fs\.renameSync\(temporary, destination\)/);
    assert.match(source, /Error in POST \/extract/);
    assert.match(source, /OCR simulation mode: skipping duplicate DID and unused ESCO warmups/);
    assert.match(source, /if \(ocrSimulationMode\)/);
    assert.match(source, /readSecretFile\(process\.env\.CAVS_DID_PRIVATE_KEY_FILE/);
    assert.match(source, /readSecretFile\(process\.env\.PRIVATE_KEY_FILE\)/);
    assert.match(source, /new Wallet\(selectedDIDPrivKey\)/);
    assert.match(
        source,
        /axios\.post\(\s*`\$\{veramoAgentEndpoint\}\/api\/v0\/setup\/`,\s*\{\s*privatekey:/,
    );
    assert.doesNotMatch(source, /api\/v0\/setup\/\?privatekey=/);
    const didSetup = source.split('async function ensureSelectedDidOnce()', 2)[1];
    assert.ok(didSetup);
    assert.ok(
        didSetup.indexOf('if (selectedDID) return selectedDID;')
        < didSetup.indexOf('if (!selectedDIDPrivKey || !selectedDIDETHAWalletAddr)'),
    );
    assert.doesNotMatch(
        source,
        /const selectedDIDPrivKey\s*=\s*['"]0x[0-9a-fA-F]{64}['"]/,
    );
});

test('Veramo accepts DID imports in a body and verifies key ownership', () => {
    const source = fs.readFileSync(new URL('../veramoRestAgent.ts', import.meta.url), 'utf8');

    assert.match(source, /app\.post\("\/api\/v0\/setup\/", setupEthDid\)/);
    assert.match(source, /req\.method === 'POST' \? req\.body : req\.query/);
    assert.match(source, /derivedAddress\.toLowerCase\(\) !== walletAddr\.toLowerCase\(\)/);
    assert.match(source, /privateKeyHex,\s*\n\s*\}\s+as MinimalImportableKey/);
});

test('registry routes close providers on all response paths', () => {
    const source = fs.readFileSync(new URL('./ocrOracleRegistry.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /timer\.unref/);
    const cleanupCalls = source.match(/await closeRegistryProvider\(provider\)/g) || [];
    assert.equal(cleanupCalls.length, 2);
    assert.match(source, /registeredOracleIds\.map\(async \(oracleId\)/);
});
