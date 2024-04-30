import { agent } from './veramo/setup.js'

async function main() {
    const identifier = await agent.didManagerGetByAlias({alias: 'default3'})
    const second_identifier = await agent.didManagerGetByAlias({alias: 'default4'})
    const verifiableCredential = await agent.createVerifiableCredential({
        credential: {
            issuer: {id: identifier.did},
            credentialSubject: {
                id: second_identifier.did,
                you: 'Rock',
                title: 'person',
            },
        },
        proofFormat: 'jwt',
    })
    console.log(`New credential created`)
    console.log(JSON.stringify(verifiableCredential, null, 2))

    const hash = await agent.dataStoreSaveVerifiableCredential({verifiableCredential})

    console.log(`New credential stored`)
    console.log(JSON.stringify(hash, null, 2))


    const loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})
    console.log(`Credential Loaded`)
    console.log(JSON.stringify(loaded_credential, null, 2))

    const request = await agent.createSelectiveDisclosureRequest({
        data: {
            issuer: identifier.did,
            tag: 'sdr-one',
            claims: [
                {
                    reason: 'We need it',
                    claimType: 'title',
                    essential: true,
                },
            ],
        }
    })
    console.log(`SelectiveRequest`)
    console.log(JSON.stringify(request, null, 2))


    const credentialForSDR = await agent.getVerifiableCredentialsForSdr({
        sdr: {
            claims: [
                {
                    claimType: 'title',
                    issuers: [],
                },
            ],
        },
    })
    console.log(`credentialForSDR`)
    console.log(JSON.stringify(credentialForSDR, null, 2))

    const verifiablePresentation = await agent.createVerifiablePresentation({
        presentation: {
            verifier: [identifier.did],
            holder: second_identifier.did,
            '@context': ['https://www.w3.org/2018/credentials/v1'],
            type: ['VerifiablePresentation'],
            issuanceDate: new Date().toISOString(),
            verifiableCredential: credentialForSDR[0].credentials.map((c) => c.verifiableCredential),
        },
        proofFormat: 'jwt',
        save: true,
    })
    console.log(`\n\nPresentation`)
    console.log(JSON.stringify(verifiablePresentation, null, 2))

    const validatePresentation = await agent.validatePresentationAgainstSdr({
        presentation: verifiablePresentation,
        sdr: {
            issuer: '',
            claims: [
                {
                    claimType: 'title',
                },
            ],
        },
    })
    console.log(`\n\nvalidate`)
    console.log(JSON.stringify(validatePresentation, null, 2))

    // this above gives all the veriable credentials for the selective disclousure, those can then be taken and validated

    //I will proceed if needed
}
main().catch(console.log)

