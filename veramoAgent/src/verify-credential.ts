import { agent } from './veramo/setup.js'

async function main() {
    const first_identifier = await agent.didManagerGetByAlias({alias:'default3'})

    const second_identifier = await agent.didManagerGetByAlias({alias:'default4'})

    const loaded_credential = await agent.dataStoreGetVerifiableCredential({ hash: 'QmYHVLnW2nyCdw4UBhE4w195PoVji5igLLrDNwPbyapuY7' })



    const result = await agent.verifyCredential({
        credential: loaded_credential
    })
    console.log(`Credential verified res`,     result.verified
    )

    console.log(`Credential verified err`,     result.error
    )
}

    main().catch(console.log)