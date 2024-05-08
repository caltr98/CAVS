/* eslint-disable no-console */

import { unixfs } from '@helia/unixfs'
import { FsBlockstore } from 'blockstore-fs'
import { createHelia } from 'helia'

async function main() {
    try {
        // the blockstore is where we store the blocks that make up files
        const store = new FsBlockstore('./blocstore')

        // create a Helia node
        const helia = await createHelia({
            store
        })

        // create a filesystem on top of Helia, in this case it's UnixFS
        const fs = unixfs(helia)

        // we will use this TextEncoder to turn strings into Uint8Arrays
        const encoder = new TextEncoder()

        // add the bytes to your node and receive a unique content identifier
        const cid = await fs.addBytes(encoder.encode('Hello World 201'))

        console.log('Added file:', cid.toString())

        // create a second Helia node using the same blockstore
        const helia2 = await createHelia({
            store
        })

        // create a second filesystem
        const fs2 = unixfs(helia2)

        // this decoder will turn Uint8Arrays into strings
        const decoder = new TextDecoder()
        let text = ''

        // read the file from the blockstore using the second Helia node
        for await (const chunk of fs2.cat(cid)) {
            text += decoder.decode(chunk, { stream: true })
        }

        console.log('Added file contents:', text)
        console.log("finish")
        $exit
    } catch (error) {
        console.error('Error:', error)
    }
}

main();
