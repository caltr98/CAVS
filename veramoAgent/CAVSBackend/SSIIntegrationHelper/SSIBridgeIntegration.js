import { identity } from "deso-protocol";
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();

app.use(cors());
app.use(bodyParser.json());

app.get("/api/v0/get-user-eth-addr", async (req, res) => {
    let DeSoKey = req.query.key;  // Use req.query.key to get the key from query parameters
    console.log("desokey "+DeSoKey)
    let eth_key = identity.desoAddressToEthereumAddress(DeSoKey)
    console.log("ethkey "+eth_key)
    res.json({ ethereumAddress: eth_key });
});

const PORT = 17005;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
