import { HeliaClient } from '@helia/interface'

async function main() {
    // Create a Helia client instance
    const helia = new HeliaClient()

    try {
        // Start the Helia node
        await helia.start()
        console.log('Helia node started')

        // File content to store
        const fileContent = 'Hello, IPFS with Helia!'

        // Add the file to IPFS
        const cid = await helia.store(fileContent)
        console.log(`File stored with CID: ${cid.toString()}`)

        // Retrieve the file from IPFS
        const retrievedData = await helia.retrieve(cid)
        const retrievedContent = new TextDecoder().decode(retrievedData)
        console.log(`Retrieved content: ${retrievedContent}`)

    } catch (error) {
        console.error('Error:', error)
    } finally {
        // Stop the Helia node
        await helia.stop()
        console.log('Helia node stopped')
    }
}

main()
