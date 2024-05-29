let web3 = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");
var colors = require("colors");

function replaceCharacters(inputString) {
    const replacements = {
        'I': 'i',
        'O': 'o',
        'l': 'L',
        '0': 'o'
    };
    
    // Regular expression to match all occurrences of the characters to be replaced
    const regex = new RegExp(Object.keys(replacements).join('|'), 'g');
    
    // Function to replace characters based on the mapping in the replacements object
    const replacer = (match) => replacements[match];
    
    // Replace the characters in the input string based on the mapping
    const result = inputString.replace(regex, replacer);
    
    return result;
}

generateKeywithPrefix = async (prefix) => {
  try {
    const execSync = require("child_process").execSync;
    const result = execSync(`solana-keygen grind --starts-with ${prefix}:1`);
    const consoleOutput = result.toString();

    const startIndex =
      consoleOutput.indexOf("Wrote keypair to") + "Wrote keypair to".length;
    const endIndex = consoleOutput.indexOf(".json", startIndex);
    const publicKey = consoleOutput.substring(startIndex, endIndex).trim();

    const fileContent = fs.readFileSync(`${publicKey}.json`, "utf8");
    const firstWinPrivKey = JSON.parse(fileContent).slice(0, 32);

    let firstWinWallet = web3.Keypair.fromSeed(
      Uint8Array.from(firstWinPrivKey)
    );

    const privKey = bs58.encode(firstWinWallet.secretKey);
    console.log(`${privKey.slice(0, 4)}`.red, `${privKey.slice(4)}`.hidden);
    console.log(publicKey);

    fs.unlinkSync(`${publicKey}.json`);
  } catch (error) {
    console.error(error);
  }
};

const args = process.argv.slice(2);
const prefix = args[0];

generateKeywithPrefix(replaceCharacters(prefix));
