// Core interfaces
import {
    createAgent,
    IDIDManager,
    IResolver,
    IDataStore,
    IDataStoreORM,
    IKeyManager,
    ICredentialPlugin,
} from '@veramo/core'

import {ICredentialIssuerLD} from "@veramo/credential-ld";

// Core identity manager plugin
import { DIDManager } from '@veramo/did-manager'

// Ethr did identity provider
import { EthrDIDProvider } from '@veramo/did-provider-ethr'

// Core key manager plugin
import { KeyManager } from '@veramo/key-manager'

// Custom key management system for RN
import { KeyManagementSystem, SecretBox } from '@veramo/kms-local'

// W3C Verifiable Credential plugin
import { CredentialPlugin } from '@veramo/credential-w3c'

// Custom resolvers
import { DIDResolverPlugin } from '@veramo/did-resolver'
import { Resolver } from 'did-resolver'
import { getResolver as ethrDidResolver } from 'ethr-did-resolver'
import { getResolver as webDidResolver } from 'web-did-resolver'

// Storage plugin using TypeOrm
import {Entities, KeyStore, DIDStore, PrivateKeyStore, migrations, DataStore, DataStoreORM} from '@veramo/data-store'

// TypeORM is installed with `@veramo/data-store`
import { DataSource } from 'typeorm'

// @see https://github.com/uport-project/veramo/blob/next/__tests__/localAgent.test.ts

const databaseFile = 'database.sqlite1';
const infuraProjectId = '05dfd704449d432ead7fdc7a2ee1fc4f';
const secretKey = 'eb4aaf0408d8af22cdb8e63913a6ce49d898451fb949490b4a82d0018d9bf9d4';


// This will be the name for the local sqlite database
const DATABASE_FILE = 'database.sqlite2'

// INITIALIZE DATABASE
const dbConnection = new DataSource({
    type: 'sqlite',
    database: DATABASE_FILE,
    synchronize: false,
    migrations,
    migrationsRun: true,
    logging: ['error', 'info', 'warn'],
    entities: Entities,
}).initialize()

const ethrDidProvider = new EthrDIDProvider({
    defaultKms: "local",
    networks: [
        {
            name: 'mainnet',
            chainId: 1,
            rpcUrl: 'https://mainnet.infura.io/v3/' + infuraProjectId,
        }],
    rpcUrl: `https://mainnet.infura.io/v3/${infuraProjectId}`,
    gas: 1000001,
    ttl: 60 * 60 * 24 * 30 * 12 + 1,
});



export const agentETH = createAgent<
    IDIDManager & IKeyManager & IDataStore & IDataStoreORM & IResolver & ICredentialPlugin & ICredentialIssuerLD
>({
    context: {
        // authenticatedDid: 'did:example:3456'
    },
    plugins: [
        new KeyManager({
            store: new KeyStore(dbConnection),
            kms: {
                local: new KeyManagementSystem(new PrivateKeyStore(dbConnection, new SecretBox(secretKey))),
            },
        }),
        new DIDManager({
            store: new DIDStore(dbConnection),
            defaultProvider: 'did:ethr',
            providers: {
                'did:ethr': ethrDidProvider
            },
        }),
        new DIDResolverPlugin({
            resolver: new Resolver({
                ...ethrDidResolver({ infuraProjectId: infuraProjectId }),
                ...webDidResolver(),
            }),
        }),
        new DataStore(dbConnection),
        new DataStoreORM(dbConnection)
    ],
});