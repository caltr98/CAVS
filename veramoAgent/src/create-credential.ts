import { agent } from './veramo/setup.js'

async function main() {
    const identifier = await agent.didManagerGetByAlias({ alias: 'default3' })
    const second_identifier = await agent.didManagerGetByAlias({alias:'default4'})
    const verifiableCredential = await agent.createVerifiableCredential({
        credential: {
            issuer: { id: identifier.did },
            credentialSubject: {
                id: second_identifier.did,
                you: 'Rock',
                title:'person',
            },
        },
        proofFormat: 'jwt',
    })
    console.log(`New credential created`)
    console.log(JSON.stringify(verifiableCredential, null, 2))

    const hash = await agent.dataStoreSaveVerifiableCredential({ verifiableCredential })

    console.log(`New credential stored`)
    console.log(JSON.stringify(hash, null, 2))


    const loaded_credential = await agent.dataStoreGetVerifiableCredential({  hash:hash })
    console.log(`Credential Loaded`)
    console.log(JSON.stringify(loaded_credential, null, 2))

}

main().catch(console.log)