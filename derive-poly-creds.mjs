import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const host = "https://clob.polymarket.com";
const chainId = 137;

const privateKey = process.env.POLY_PRIVATE_KEY;
const funder = process.env.POLY_FUNDER;
const signatureType = Number(process.env.POLY_SIGNATURE_TYPE || "2");

if (!privateKey) throw new Error("Missing POLY_PRIVATE_KEY");
if (!funder) throw new Error("Missing POLY_FUNDER");

const wallet = new Wallet(privateKey);
const client = new ClobClient(host, chainId, wallet, undefined, signatureType, funder);
const creds = await client.createOrDeriveApiKey();

console.log("POLY_API_KEY=" + creds.key);
console.log("POLY_API_SECRET=" + creds.secret);
console.log("POLY_API_PASSPHRASE=" + creds.passphrase);
