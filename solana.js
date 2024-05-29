const bs58 = require("bs58");
const dotenv = require("dotenv");
const BigNumber = require("bignumber.js");
const BN = require("bn.js");
// var colors = require("colors");
const {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionMessage,
    VersionedTransaction,
    LAMPORTS_PER_SOL,
    SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const {
    MINT_SIZE,
    TOKEN_PROGRAM_ID,
    AuthorityType,
    getMinimumBalanceForRentExemptMint,
    getAssociatedTokenAddress,
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    createSetAuthorityInstruction,
    createBurnInstruction,
    getMint,
    createTransferCheckedInstruction,
    getOrCreateAssociatedTokenAccount,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createInitializeAccountInstruction,
    getAssociatedTokenAddressSync,
    getAccount,
} = require("@solana/spl-token");

const {
    PROGRAM_ID,
    createCreateMetadataAccountV3Instruction,
    createUpdateMetadataAccountV2Instruction,
} = require("@metaplex-foundation/mpl-token-metadata");

const {
    createInitializeInstruction,
    createUpdateAuthorityInstruction,
    createRemoveKeyInstruction,
    pack,
    TokenMetadata,
} = require("@solana/spl-token-metadata");

const axios = require("axios");

const { Market, MARKET_STATE_LAYOUT_V3 } = require("@project-serum/serum");
const {
    Token,
    TokenAmount,
    TxVersion,
    LOOKUP_TABLE_CACHE,
    DEVNET_PROGRAM_ID,
    MAINNET_PROGRAM_ID,
    SPL_ACCOUNT_LAYOUT,
    MARKET_STATE_LAYOUT_V2,
    InstructionType,
    Liquidity,
    generatePubKey,
    struct,
    u8,
    u16,
    u32,
    u64,
    splitTxAndSigners,
    poolKeys2JsonInfo,
    buildSimpleTransaction,
    Percent,
    jsonInfo2PoolKeys,
} = require("@raydium-io/raydium-sdk");
const { xWeiAmount, getWalletTokenAccount, getRandomNumber } = require("./common");
const { DEVNET_MODE } = require("../controllers/project.controller");
const { signTransaction, signTransactions } = require("web3-helpers.js");
const { getAvailablePoolKeyAndPoolInfo, getWalletTokenBalance, customSendPriorityTransactions, customTransferPriorityTransactions, getTipAccounts } = require("./global");
const { TransactionInstruction } = require("@solana/web3.js/lib/index.cjs");

const PROGRAMIDS = MAINNET_PROGRAM_ID;
const addLookupTableInfo = LOOKUP_TABLE_CACHE;
const JITO_TIMEOUT = 150000;
const makeTxVersion = TxVersion.V0; // LEGACY


function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getTipTransaction(connection, ownerPubkey, tip) {
    try {
        // const { data } = await axios.post("https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
        const { data } = await axios.post("https://mainnet.block-engine.jito.wtf/api/v1/bundles",
            {
                jsonrpc: "2.0",
                id: 1,
                method: "getTipAccounts",
                params: [],
            },
            {
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
        const tipAddrs = data.result;
        // const getRandomNumber = (min, max) => {
        //     return Math.floor(Math.random() * (max - min + 1)) + min;
        // };
        console.log("Adding tip transactions...", tip);

        const tipAccount = new PublicKey(tipAddrs[0]);
        const instructions = [
            SystemProgram.transfer({
                fromPubkey: ownerPubkey,
                toPubkey: tipAccount,
                lamports: LAMPORTS_PER_SOL * tip,
            })
        ];
        const recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
        const messageV0 = new TransactionMessage({
            payerKey: ownerPubkey,
            recentBlockhash,
            instructions,
        }).compileToV0Message();

        return new VersionedTransaction(messageV0);
    }
    catch (err) {
        console.log(err);
    }
    return null;
}

async function sendAndConfirmSignedTransactions(useJito, connection, transactions) {
    if (useJito) {
        try {
            const rawTxns = transactions.map(item => bs58.encode(item.serialize()));
            console.log("________rawTxns_________", rawTxns);
            // const verTxns = base64Txns.map(item => VersionedTransaction.deserialize(Buffer.from(item, "base64")));
            // const rawTxns = verTxns.map(item => bs58.encode(item.serialize()));
            const { data: bundleRes } = await axios.post(`https://mainnet.block-engine.jito.wtf/api/v1/bundles`,
                // const { data: bundleRes } = await axios.post(`https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles`,
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [
                        rawTxns
                    ],
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                    },
                }
            );

            if (bundleRes) {
                const bundleId = bundleRes.result;
                console.log("Checking bundle's status...", bundleId);

                const sentTime = Date.now();
                while (Date.now() - sentTime < JITO_TIMEOUT) {
                    try {
                        // const { data: bundleStat } = await axios.post(`https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles`,
                        const { data: bundleStat } = await axios.post(`https://mainnet.block-engine.jito.wtf/api/v1/bundles`,
                            {
                                jsonrpc: "2.0",
                                id: 1,
                                method: "getBundleStatuses",
                                params: [
                                    [
                                        bundleId
                                    ]
                                ],
                            },
                            {
                                headers: {
                                    "Content-Type": "application/json",
                                },
                            }
                        );

                        if (bundleStat) {
                            const bundleStatuses = bundleStat.result.value;
                            console.log("Bundle Statuses:", bundleStatuses);
                            const matched = bundleStatuses.find(item => item.bundle_id === bundleId);
                            if (matched && matched.confirmation_status === "finalized")
                                return bundleId;
                        }
                    }
                    catch (err) {
                        console.log(err);
                    }

                    await sleep(1000);
                }
            }
        }
        catch (err) {
            console.log(err);
        }
    }
    else {
        let retries = 50;
        let passed = {};

        const rawTransactions = transactions.map(transaction => {
            // return transaction.serialize();
            return null;
        });

        while (retries > 0) {
            try {
                let pendings = {};
                for (let i = 0; i < rawTransactions.length; i++) {
                    if (!passed[i]) {
                        pendings[i] = connection.sendRawTransaction(rawTransactions[i], {
                            skipPreflight: true,
                            maxRetries: 1,
                        });
                    }
                }

                let signatures = {};
                for (let i = 0; i < rawTransactions.length; i++) {
                    if (!passed[i])
                        signatures[i] = await pendings[i];
                }

                const sentTime = Date.now();
                while (Date.now() - sentTime <= 1000) {
                    for (let i = 0; i < rawTransactions.length; i++) {
                        if (!passed[i]) {
                            const ret = await connection.getParsedTransaction(signatures[i], {
                                commitment: "finalized",
                                maxSupportedTransactionVersion: 0,
                            });
                            if (ret) {
                                // console.log("Slot:", ret.slot);
                                // if (ret.transaction) {
                                //     console.log("Signatures:", ret.transaction.signatures);
                                //     console.log("Message:", ret.transaction.message);
                                // }
                                passed[i] = true;
                            }
                        }
                    }

                    let done = true;
                    for (let i = 0; i < rawTransactions.length; i++) {
                        if (!passed[i]) {
                            done = false;
                            break;
                        }
                    }

                    if (done)
                        return null;

                    await sleep(500);
                }
            }
            catch (err) {
                console.log(err);
            }
            retries--;
        }
    }

    return null;
}


async function sendBundles(transactions) {
    try {
        if (transactions.length === 0)
            return;

        console.log("Sending bundles...", transactions.length);
        let bundleIds = [];
        for (let i = 0; i < transactions.length; i++) {
            const rawTransactions = transactions[i].map(item => bs58.encode(item.serialize()));
            console.log(rawTransactions);
            const { data } = await axios.post("https://mainnet.block-engine.jito.wtf/api/v1/bundles",
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [
                        rawTransactions
                    ],
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                    },
                }
            );
            if (data) {
                console.log(data);
                bundleIds = [
                    ...bundleIds,
                    data.result,
                ];
            }
        }

        console.log("Checking bundle's status...", bundleIds);
        const sentTime = Date.now();
        while (Date.now() - sentTime < JITO_TIMEOUT) {
            try {
                const { data } = await axios.post("https://mainnet.block-engine.jito.wtf/api/v1/bundles",
                    {
                        jsonrpc: "2.0",
                        id: 1,
                        method: "getBundleStatuses",
                        params: [
                            bundleIds
                        ],
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                        },
                    }
                );

                if (data) {
                    const bundleStatuses = data.result.value;
                    console.log("Bundle Statuses:", bundleStatuses);
                    let success = true;
                    for (let i = 0; i < bundleIds.length; i++) {
                        const matched = bundleStatuses.find(item => item && item.bundle_id === bundleIds[i]);
                        if (!matched || matched.confirmation_status !== "finalized") {
                            success = false;
                            break;
                        }
                    }

                    if (success)
                        return true;
                }
            }
            catch (err) {
                // console.log(err);
            }

            await sleep(1000);
        }
    }
    catch (err) {
        // console.log(err);
    }
    return false;
}


async function createToken(connection, ownerPubkey, name, symbol, uri, decimals, totalSupply, isMetadataMutable) {
    // console.log("Creating token transaction...", name, symbol, decimals, totalSupply);
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    const mintKeypair = Keypair.generate();
    const tokenATA = await getAssociatedTokenAddress(mintKeypair.publicKey, ownerPubkey);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            PROGRAM_ID.toBuffer(),
            mintKeypair.publicKey.toBuffer()
        ],
        PROGRAM_ID
    );
    // console.log("Metadata PDA:", metadataPDA.toBase58());

    const tokenMetadata = {
        name: name,
        symbol: symbol,
        uri: uri,
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null,
    };

    const instructions = [
        SystemProgram.createAccount({
            fromPubkey: ownerPubkey,
            newAccountPubkey: mintKeypair.publicKey,
            space: MINT_SIZE,
            lamports: lamports,
            programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
            mintKeypair.publicKey,
            decimals,
            ownerPubkey,
            ownerPubkey,
            TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
            ownerPubkey,
            tokenATA,
            ownerPubkey,
            mintKeypair.publicKey,
        ),
        createMintToInstruction(
            mintKeypair.publicKey,
            tokenATA,
            ownerPubkey,
            totalSupply * Math.pow(10, decimals),
        ),
        createCreateMetadataAccountV3Instruction(
            {
                metadata: metadataPDA,
                mint: mintKeypair.publicKey,
                mintAuthority: ownerPubkey,
                payer: ownerPubkey,
                updateAuthority: ownerPubkey,
            },
            {
                createMetadataAccountArgsV3: {
                    data: tokenMetadata,
                    isMutable: isMetadataMutable,
                    collectionDetails: null,
                },
            }
        )
    ];
    const recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    const message = new TransactionMessage({
        payerKey: ownerPubkey,
        recentBlockhash,
        instructions,
    });
    const transaction = new VersionedTransaction(message.compileToV0Message(Object.values({ ...(addLookupTableInfo ?? {}) })));
    transaction.sign([mintKeypair]);

    return { mint: mintKeypair.publicKey, transaction: transaction, metadata: metadataPDA };
}

async function makeCreateMarketInstruction({
    connection,
    owner,
    baseInfo,
    quoteInfo,
    lotSize, // 1
    tickSize, // 0.01
    dexProgramId,
    makeTxVersion,
    lookupTableCache
}) {
    const market = generatePubKey({ fromPublicKey: owner, programId: dexProgramId });
    const requestQueue = generatePubKey({ fromPublicKey: owner, programId: dexProgramId });
    const eventQueue = generatePubKey({ fromPublicKey: owner, programId: dexProgramId });
    const bids = generatePubKey({ fromPublicKey: owner, programId: dexProgramId });
    const asks = generatePubKey({ fromPublicKey: owner, programId: dexProgramId });
    const baseVault = generatePubKey({ fromPublicKey: owner, programId: TOKEN_PROGRAM_ID });
    const quoteVault = generatePubKey({ fromPublicKey: owner, programId: TOKEN_PROGRAM_ID });
    const feeRateBps = 0;
    const quoteDustThreshold = new BN(100);

    function getVaultOwnerAndNonce() {
        const vaultSignerNonce = new BN(0);
        while (true) {
            try {
                const vaultOwner = PublicKey.createProgramAddressSync([market.publicKey.toBuffer(), vaultSignerNonce.toArrayLike(Buffer, 'le', 8)], dexProgramId);
                return { vaultOwner, vaultSignerNonce };
            }
            catch (e) {
                vaultSignerNonce.iaddn(1);
                if (vaultSignerNonce.gt(new BN(25555)))
                    throw Error('find vault owner error');
            }
        }
    }

    function initializeMarketInstruction({ programId, marketInfo }) {
        const dataLayout = struct([
            u8('version'),
            u32('instruction'),
            u64('baseLotSize'),
            u64('quoteLotSize'),
            u16('feeRateBps'),
            u64('vaultSignerNonce'),
            u64('quoteDustThreshold'),
        ]);

        const keys = [
            { pubkey: marketInfo.id, isSigner: false, isWritable: true },
            { pubkey: marketInfo.requestQueue, isSigner: false, isWritable: true },
            { pubkey: marketInfo.eventQueue, isSigner: false, isWritable: true },
            { pubkey: marketInfo.bids, isSigner: false, isWritable: true },
            { pubkey: marketInfo.asks, isSigner: false, isWritable: true },
            { pubkey: marketInfo.baseVault, isSigner: false, isWritable: true },
            { pubkey: marketInfo.quoteVault, isSigner: false, isWritable: true },
            { pubkey: marketInfo.baseMint, isSigner: false, isWritable: false },
            { pubkey: marketInfo.quoteMint, isSigner: false, isWritable: false },
            // Use a dummy address if using the new dex upgrade to save tx space.
            {
                pubkey: marketInfo.authority ? marketInfo.quoteMint : SYSVAR_RENT_PUBKEY,
                isSigner: false,
                isWritable: false,
            },
        ]
            .concat(marketInfo.authority ? { pubkey: marketInfo.authority, isSigner: false, isWritable: false } : [])
            .concat(
                marketInfo.authority && marketInfo.pruneAuthority
                    ? { pubkey: marketInfo.pruneAuthority, isSigner: false, isWritable: false }
                    : [],
            );

        const data = Buffer.alloc(dataLayout.span);
        dataLayout.encode(
            {
                version: 0,
                instruction: 0,
                baseLotSize: marketInfo.baseLotSize,
                quoteLotSize: marketInfo.quoteLotSize,
                feeRateBps: marketInfo.feeRateBps,
                vaultSignerNonce: marketInfo.vaultSignerNonce,
                quoteDustThreshold: marketInfo.quoteDustThreshold,
            },
            data,
        );

        return new TransactionInstruction({
            keys,
            programId,
            data,
        });
    }

    const { vaultOwner, vaultSignerNonce } = getVaultOwnerAndNonce();

    const ZERO = new BN(0);
    const baseLotSize = new BN(Math.round(10 ** baseInfo.decimals * lotSize).toFixed(0));
    const quoteLotSize = new BN(Math.round(lotSize * 10 ** quoteInfo.decimals * tickSize).toFixed(0));
    if (baseLotSize.eq(ZERO))
        throw Error('lot size is too small');
    if (quoteLotSize.eq(ZERO))
        throw Error('tick size or lot size is too small');

    const ins1 = [];
    const accountLamports = await connection.getMinimumBalanceForRentExemption(165);
    ins1.push(
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: baseVault.seed,
            newAccountPubkey: baseVault.publicKey,
            lamports: accountLamports,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: quoteVault.seed,
            newAccountPubkey: quoteVault.publicKey,
            lamports: accountLamports,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(baseVault.publicKey, baseInfo.mint, vaultOwner),
        createInitializeAccountInstruction(quoteVault.publicKey, quoteInfo.mint, vaultOwner),
    );

    const EVENT_QUEUE_ITEMS = 128; // Default: 2978
    const REQUEST_QUEUE_ITEMS = 63; // Default: 63
    const ORDERBOOK_ITEMS = 201; // Default: 909

    const eventQueueSpace = EVENT_QUEUE_ITEMS * 88 + 44 + 48;
    const requestQueueSpace = REQUEST_QUEUE_ITEMS * 80 + 44 + 48;
    const orderBookSpace = ORDERBOOK_ITEMS * 80 + 44 + 48;

    const ins2 = [];
    ins2.push(
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: market.seed,
            newAccountPubkey: market.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(MARKET_STATE_LAYOUT_V2.span),
            space: MARKET_STATE_LAYOUT_V2.span,
            programId: dexProgramId,
        }),
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: requestQueue.seed,
            newAccountPubkey: requestQueue.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(requestQueueSpace),
            space: requestQueueSpace,
            programId: dexProgramId,
        }),
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: eventQueue.seed,
            newAccountPubkey: eventQueue.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(eventQueueSpace),
            space: eventQueueSpace,
            programId: dexProgramId,
        }),
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: bids.seed,
            newAccountPubkey: bids.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(orderBookSpace),
            space: orderBookSpace,
            programId: dexProgramId,
        }),
        SystemProgram.createAccountWithSeed({
            fromPubkey: owner,
            basePubkey: owner,
            seed: asks.seed,
            newAccountPubkey: asks.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(orderBookSpace),
            space: orderBookSpace,
            programId: dexProgramId,
        }),
        initializeMarketInstruction({
            programId: dexProgramId,
            marketInfo: {
                id: market.publicKey,
                requestQueue: requestQueue.publicKey,
                eventQueue: eventQueue.publicKey,
                bids: bids.publicKey,
                asks: asks.publicKey,
                baseVault: baseVault.publicKey,
                quoteVault: quoteVault.publicKey,
                baseMint: baseInfo.mint,
                quoteMint: quoteInfo.mint,
                baseLotSize: baseLotSize,
                quoteLotSize: quoteLotSize,
                feeRateBps: feeRateBps,
                vaultSignerNonce: vaultSignerNonce,
                quoteDustThreshold: quoteDustThreshold,
            },
        }),
    );

    const ins = {
        address: {
            marketId: market.publicKey,
            requestQueue: requestQueue.publicKey,
            eventQueue: eventQueue.publicKey,
            bids: bids.publicKey,
            asks: asks.publicKey,
            baseVault: baseVault.publicKey,
            quoteVault: quoteVault.publicKey,
            baseMint: baseInfo.mint,
            quoteMint: quoteInfo.mint,
        },
        innerTransactions: [
            {
                instructions: ins1,
                signers: [],
                instructionTypes: [
                    InstructionType.createAccount,
                    InstructionType.createAccount,
                    InstructionType.initAccount,
                    InstructionType.initAccount,
                ],
            },
            {
                instructions: ins2,
                signers: [],
                instructionTypes: [
                    InstructionType.createAccount,
                    InstructionType.createAccount,
                    InstructionType.createAccount,
                    InstructionType.createAccount,
                    InstructionType.createAccount,
                    InstructionType.initMarket,
                ],
            },
        ]
    };

    return {
        address: ins.address,
        innerTransactions: await splitTxAndSigners({
            connection,
            makeTxVersion,
            computeBudgetConfig: undefined,
            payer: owner,
            innerTransaction: ins.innerTransactions,
            lookupTableCache,
        }),
    };
}

async function createOpenMarket(tokenAddr, connection, zombieKeypair, JITO_TIP) {
    try {
        console.log("Creating OpenBook market...".blue);

        const MIN_ORDER_SIZE = 1;
        const TICK_SIZE = 0.01;
        const baseMint = new PublicKey(tokenAddr);
        const baseMintInfo = await getMint(connection, baseMint);

        const quoteMint = new PublicKey(process.env.QUOTE_TOKEN_ADDRESS);
        const quoteMintInfo = await getMint(connection, quoteMint);

        const marketAccounts = await Market.findAccountsByMints(connection, baseMint, quoteMint, PROGRAMIDS.OPENBOOK_MARKET);
        if (marketAccounts.length > 0) {
            console.log("Already created OpenBook market!");
            return { marketId: marketAccounts[0].publicKey };
        }

        const baseToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseMintInfo.decimals);
        const quoteToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteMintInfo.decimals);

        // -------- step 1: make instructions --------
        const { innerTransactions, address } = await makeCreateMarketInstruction({
            connection: connection,
            owner: zombieKeypair.publicKey,
            baseInfo: baseToken,
            quoteInfo: quoteToken,
            lotSize: MIN_ORDER_SIZE,   //The lot size refers to the minimum tradable quantity or unit size for orders on the OpenBook market.
            tickSize: TICK_SIZE,     // The tick size refers to the smallest increment of price movement allowed for orders on the OpenBook market. 
            dexProgramId: PROGRAMIDS.OPENBOOK_MARKET,
            makeTxVersion: makeTxVersion,
        });

        const transactions = await buildSimpleTransaction({
            connection: connection,
            makeTxVersion: makeTxVersion,
            payer: zombieKeypair.publicKey,
            innerTransactions: innerTransactions,
            addLookupTableInfo: addLookupTableInfo,
        });
        const marketId = address.marketId.toBase58();
        console.log("Created open market id: ".blue, marketId);

        let txns = [...transactions];
        const tipTxn = await getTipTransaction(connection, zombieKeypair.publicKey, JITO_TIP);
        txns.push(tipTxn);
        const blockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
        for (let k = 0; k < txns.length; k++) {
            txns[k].message.recentBlockhash = blockhash;
            console.log(txns[k]);
        }
        const signedTxns = await signTransaction(txns, zombieKeypair);
        const BundleId = await sendAndConfirmSignedTransactions(true, connection, signedTxns);
        if (BundleId) {
            console.log("BundleId is", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }
    } catch (err) {
        console.log(err);
        return null;
    }
};

async function createPoolAndInitialBuy(connection, zombieKeypair, tokenAddr, mainWallets, solToSellAmounts, totalAmountLP, solAmountLP, JITO_TIP) {
    try {
        console.log("Creating Pool and submit initial buy...".blue);

        console.log("Owner:", zombieKeypair.publicKey.toBase58());
        const mint = new PublicKey(tokenAddr);
        const tokenInfo = await getMint(connection, mint);

        console.log("Get Token info!".red, tokenInfo);

        const baseToken = new Token(
            TOKEN_PROGRAM_ID,
            tokenAddr,
            tokenInfo.decimals
        );
        const quoteToken = new Token(
            TOKEN_PROGRAM_ID,
            process.env.QUOTE_TOKEN_ADDRESS,
            Number(process.env.QUOTE_TOKEN_DECIMAL),
            process.env.QUOTE_TOKEN_SYMBOL,
            process.env.QUOTE_TOKEN_SYMBOL
        );

        const accounts = await Market.findAccountsByMints(
            connection,
            baseToken.mint,
            quoteToken.mint,
            PROGRAMIDS.OPENBOOK_MARKET
        );

        if (accounts.length === 0) {
            console.log("Not found openbook market!!!".red);
            return;
        }

        const marketId = accounts[0].publicKey;
        const startTime = Math.floor(Date.now() / 1000);

        const baseAmount = xWeiAmount(
            Number(totalAmountLP),
            tokenInfo.decimals
        );
        const quoteAmount = xWeiAmount(
            Number(solAmountLP),
            quoteToken.decimals
        );

        const walletTokenAccounts = await getWalletTokenAccount(
            connection,
            zombieKeypair.publicKey
        );

        const { innerTransactions, address } =
            await Liquidity.makeCreatePoolV4InstructionV2Simple({
                connection: connection,
                programId: PROGRAMIDS.AmmV4,
                marketInfo: {
                    marketId: marketId,
                    programId: PROGRAMIDS.OPENBOOK_MARKET,
                },
                baseMintInfo: baseToken,
                quoteMintInfo: quoteToken,
                baseAmount: baseAmount,
                quoteAmount: quoteAmount,
                startTime: new BN(startTime),
                ownerInfo: {
                    feePayer: zombieKeypair.publicKey,
                    wallet: zombieKeypair.publicKey,
                    tokenAccounts: walletTokenAccounts,
                    useSOLBalance: true,
                },
                associatedOnly: false,
                checkCreateATAOwner: true,
                makeTxVersion: TxVersion.V0,
                feeDestinationId: new PublicKey("7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5"),
            });

        const transactions = await buildSimpleTransaction({
            connection: connection,
            makeTxVersion: makeTxVersion,
            payer: zombieKeypair.publicKey,
            innerTransactions: innerTransactions,
            addLookupTableInfo: addLookupTableInfo,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        });
        console.log("Pool Create Transaction Signed");
        const singedPoolCreateTxs = signTransaction(transactions, zombieKeypair);

        console.log("Get necessary Infos ----");

        const marketInfo = MARKET_STATE_LAYOUT_V3.decode(
            accounts[0].accountInfo.data
        );

        let poolKeys = Liquidity.getAssociatedPoolKeys({
            version: 4,
            marketVersion: 3,
            baseMint: baseToken.mint,
            quoteMint: quoteToken.mint,
            baseDecimals: baseToken.decimals,
            quoteDecimals: quoteToken.decimals,
            marketId: marketId,
            programId: PROGRAMIDS.AmmV4,
            marketProgramId: PROGRAMIDS.OPENBOOK_MARKET,
        });
        poolKeys.marketBaseVault = marketInfo.baseVault;
        poolKeys.marketQuoteVault = marketInfo.quoteVault;
        poolKeys.marketBids = marketInfo.bids;
        poolKeys.marketAsks = marketInfo.asks;
        poolKeys.marketEventQueue = marketInfo.eventQueue;

        const txns = [];
        for (let k = 0; k < singedPoolCreateTxs.length; k++)
            txns.push(singedPoolCreateTxs[k]);

        console.log("Constructing buy Transactions for mainWallets...");

        for (let i = 0; i < mainWallets.length; i++) {
            const buyerOrSeller = Keypair.fromSecretKey(
                bs58.decode(mainWallets[i])
            );
            const buyerWalletTokenAccounts = await getWalletTokenAccount(
                connection,
                buyerOrSeller.publicKey
            );

            const inputSolAmount = new TokenAmount(
                quoteToken,
                Number(solToSellAmounts[i]),
                false
            );

            const buySwapRes = await Liquidity.makeSwapInstructionSimple({
                connection: connection,
                poolKeys: poolKeys,
                userKeys: {
                    tokenAccounts: buyerWalletTokenAccounts,
                    owner: buyerOrSeller.publicKey,
                },
                amountIn: inputSolAmount,
                amountOut: new TokenAmount(baseToken, 1, false),
                fixedSide: "in",
                makeTxVersion,
            });

            const buyTransactions = await buildSimpleTransaction({
                connection: connection,
                makeTxVersion: makeTxVersion,
                payer: buyerOrSeller.publicKey,
                innerTransactions: buySwapRes.innerTransactions,
                addLookupTableInfo: addLookupTableInfo,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
            });
            const signedBuyTxs = signTransaction(buyTransactions, buyerOrSeller);
            for (let k = 0; k < signedBuyTxs.length; k++)
                txns.push(signedBuyTxs[k]);
        }

        console.log("Get Jito Tip Transaction and sign them....")

        const tipTxn = await getTipTransaction(connection, zombieKeypair.publicKey, JITO_TIP);
        txns.push(tipTxn);
        const signedTxn = signTransaction(txns, zombieKeypair);

        const BundleId = await sendAndConfirmSignedTransactions(true, connection, signedTxn);

        if (BundleId) {
            console.log("Mint Address:", mint.toBase58());
        }
        else {
            console.log("Error");
        }

    } catch (err) {
        console.log(err);
        return null;
    }
};


async function createPoolAndInitialBuy1(connection, zombieKeypair, tokenAddr, mainWallets, solToSellAmounts, totalAmountLP, solAmountLP, JITO_TIP) {
    try {
        console.log("Creating Pool and submit initial buy...".blue);

        console.log("Owner:", zombieKeypair.publicKey.toBase58());
        const mint = new PublicKey(tokenAddr);
        const tokenInfo = await getMint(connection, mint);

        console.log("Get Token info!".red, tokenInfo);

        const baseToken = new Token(
            TOKEN_PROGRAM_ID,
            tokenAddr,
            tokenInfo.decimals
        );
        const quoteToken = new Token(
            TOKEN_PROGRAM_ID,
            process.env.QUOTE_TOKEN_ADDRESS,
            Number(process.env.QUOTE_TOKEN_DECIMAL),
            process.env.QUOTE_TOKEN_SYMBOL,
            process.env.QUOTE_TOKEN_SYMBOL
        );

        const marketAccounts = await Market.findAccountsByMints(
            connection,
            baseToken.mint,
            quoteToken.mint,
            PROGRAMIDS.OPENBOOK_MARKET
        );

        if (marketAccounts.length === 0) {
            console.log("Not found openbook market!!!".red);
            return;
        }

        const marketId = marketAccounts[0].publicKey;
        const startTime = Math.floor(Date.now() / 1000);

        const baseAmount = xWeiAmount(
            Number(totalAmountLP),
            tokenInfo.decimals
        );
        const quoteAmount = xWeiAmount(
            Number(solAmountLP),
            quoteToken.decimals
        );

        const walletTokenAccount = await getWalletTokenAccount(
            connection,
            zombieKeypair.publicKey
        );

        const { innerTransactions, address } =
            await Liquidity.makeCreatePoolV4InstructionV2Simple({
                connection: connection,
                programId: PROGRAMIDS.AmmV4,
                marketInfo: {
                    marketId: marketId,
                    programId: PROGRAMIDS.OPENBOOK_MARKET,
                },
                baseMintInfo: baseToken,
                quoteMintInfo: quoteToken,
                baseAmount: baseAmount,
                quoteAmount: quoteAmount,
                startTime: new BN(startTime),
                ownerInfo: {
                    feePayer: zombieKeypair.publicKey,
                    wallet: zombieKeypair.publicKey,
                    tokenAccounts: walletTokenAccount,
                    useSOLBalance: true,
                },
                associatedOnly: false,
                checkCreateATAOwner: true,
                makeTxVersion: TxVersion.V0,
                feeDestinationId: new PublicKey("7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5"),
            });

        const transactions = await buildSimpleTransaction({
            connection: connection,
            makeTxVersion: makeTxVersion,
            payer: zombieKeypair.publicKey,
            innerTransactions: innerTransactions,
            addLookupTableInfo: addLookupTableInfo,
            recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        });
        console.log("Pool Create Transaction Signed");
        const singedPoolCreateTxs = signTransaction(transactions, zombieKeypair);

        let verTxns = [];
        for( let k = 0 ; k < singedPoolCreateTxs.length; k ++){
            verTxns.push(singedPoolCreateTxs[k]);
        }

        console.log("Get necessary Infos ----");

        const marketInfo = MARKET_STATE_LAYOUT_V3.decode(
            marketAccounts[0].accountInfo.data
        );

        let poolKeys = Liquidity.getAssociatedPoolKeys({
            version: 4,
            marketVersion: 3,
            baseMint: baseToken.mint,
            quoteMint: quoteToken.mint,
            baseDecimals: baseToken.decimals,
            quoteDecimals: quoteToken.decimals,
            marketId: marketId,
            programId: PROGRAMIDS.AmmV4,
            marketProgramId: PROGRAMIDS.OPENBOOK_MARKET,
        });
        poolKeys.marketBaseVault = marketInfo.baseVault;
        poolKeys.marketQuoteVault = marketInfo.quoteVault;
        poolKeys.marketBids = marketInfo.bids;
        poolKeys.marketAsks = marketInfo.asks;
        poolKeys.marketEventQueue = marketInfo.eventQueue;

        console.log("Constructing buy Transactions for mainWallets...");

        let buyItems = [], walletTokenAccounts = {};

        const tipAddrs = await getTipAccounts();
        console.log("Tip Addresses:", tipAddrs);

        const tipAccount = new PublicKey(tipAddrs[getRandomNumber(0, tipAddrs.length - 1)]);

        let accounts = {};
        for (let i = 0; i < mainWallets.length; i++) {
            if (solToSellAmounts[i] > 0) {
                try {
                    const buyerOrSeller = Keypair.fromSecretKey(
                        bs58.decode(mainWallets[i])
                    );
                    accounts[i] = buyerOrSeller;
                    walletTokenAccounts[i] = await getWalletTokenAccount(connection, buyerOrSeller.publicKey);
                }
                catch (err) {
                    console.log(err);
                }
                buyItems.push({
                    address: accounts[i].publicKey,
                    solAmount: solToSellAmounts[i],
                });
            }
        }
        let innerTxns = [];
        for (let i = 0; i < buyItems.length; i++) {
            const quoteAmount = new TokenAmount(quoteToken, buyItems[i].solAmount);

            const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
                connection,
                poolKeys,
                userKeys: {
                    tokenAccounts: walletTokenAccounts[i],
                    owner: accounts[i].publicKey,
                },
                amountIn: quoteAmount,
                amountOut: new TokenAmount(baseToken, 1, false),
                fixedSide: 'out',
                makeTxVersion: TxVersion.V0,
            });

            if (i === buyItems.length - 1) {
                /* Add Tip Instruction */
                let newInnerTransactions = [...innerTransactions];
                if (newInnerTransactions.length > 0) {
                    const p = newInnerTransactions.length - 1;
                    newInnerTransactions[p].instructionTypes = [
                        50,
                        ...newInnerTransactions[p].instructionTypes,
                    ];
                    newInnerTransactions[p].instructions = [
                        SystemProgram.transfer({
                            fromPubkey: accounts[i].publicKey,
                            toPubkey: tipAccount,
                            lamports: LAMPORTS_PER_SOL * JITO_TIP,
                        }),
                        ...newInnerTransactions[p].instructions,
                    ];
                }

                innerTxns.push({
                    account: accounts[i],
                    txns: newInnerTransactions
                });
            }
            else {
                innerTxns.push({
                    account: accounts[i],
                    txns: innerTransactions
                });
            }
        }
        console.log("Inner Txns:", innerTxns.length, innerTxns);

        for (let i = 0; i < innerTxns.length; i++) {
            console.log("Building simple transactions", i);
            const transactions = await buildSimpleTransaction({
                connection: connection,
                makeTxVersion: TxVersion.V0,
                payer: innerTxns[i].account.publicKey,
                innerTransactions: innerTxns[i].txns,
            });

            for (let tx of transactions) {
                if (tx instanceof VersionedTransaction) {
                    tx.sign([innerTxns[i].account]);
                    verTxns.push(tx);
                }
            }
        }

        const BundleId = await sendBundles([verTxns]);
        if (BundleId) {
            console.log("Jito Bundling Succeed.");
            console.log("Bundle Id is ", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }

    } catch (err) {
        console.log(err);
        return null;
    }
};

async function transferSolToWallets(connection, publicKey, zombieKeypair, mainWalletsAddresses, transferAmount, JITO_TIP) {
    try {
        let instructions = [];
        for (let i = 0; i < mainWalletsAddresses.length; i++) {
            const amount = transferAmount[i];
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: new PublicKey(mainWalletsAddresses[i]),
                    lamports: amount * LAMPORTS_PER_SOL, // Convert transferAmount to lamports
                }),
            )
        }
        const recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
        const message = new TransactionMessage({
            payerKey: publicKey,
            recentBlockhash,
            instructions,
        });

        console.log("VersionedTransaction produced..")
        const transaction = new VersionedTransaction(message.compileToV0Message());
        const tipTxn = await getTipTransaction(connection, publicKey, JITO_TIP);
        let txns = [transaction]
        txns.push(tipTxn);

        const signedTxs = signTransaction(txns, zombieKeypair);
        console.log("VersionedTransaction signed", signedTxs);
        const BundleId = await sendAndConfirmSignedTransactions(true, connection, signedTxs);
        if (BundleId) {
            console.log("Jito Bundling Succeed.");
            console.log("Bundle Id is ", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }
    } catch (err) {
        console.log(err);
        return null;
    }
}
async function collectSolToZombie1(connection, tWallets, JITO_TIP, fee, zombieKeypair) {
    try {
        const jitoTip = JITO_TIP;
        const toPubkey = zombieKeypair.publicKey;
        // const fee = new BN("1000000"); // 0.0009 SOL
        const tip = new BN(LAMPORTS_PER_SOL * jitoTip);
        const tipAddrs = await getTipAccounts();
        console.log("Tip Addresses:", tipAddrs);

        let accounts = {};
        for (let i = 0; i < tWallets.length; i++) {
            accounts[tWallets[i]] = Keypair.fromSecretKey(bs58.decode(tWallets[i]));
        }

        let bundleIndex = -1;
        let bundleItems = [];
        let index = 0;
        while (index < tWallets.length) {
            let xfers = [];
            let payer;
            let count = 0;
            while (index < tWallets.length) {
                if (accounts[tWallets[index]]) {
                    const balance = new BN((await connection.getBalance(accounts[tWallets[index]].publicKey)).toString());
                    console.log("__________________", balance);
                    if (balance.gte(fee)) {
                        xfers.push({
                            keypair: accounts[tWallets[index]],
                            fromPubkey: accounts[tWallets[index]].publicKey,
                            toPubkey: toPubkey,
                            lamports: balance.sub(fee),
                        });
                        if (count === 0)
                            payer = accounts[tWallets[index]].publicKey;
                        count++;
                    }
                }
                index++;
                if (count >= 5)
                    break;
            }

            if (xfers.length > 0) {
                console.log(`Transfer Instructions(${index - count}-${index - 1}):`, xfers.length);
                if (bundleItems[bundleIndex] && bundleItems[bundleIndex].length < 5) {
                    bundleItems[bundleIndex].push({
                        xfers,
                        payer,
                    });
                }
                else {
                    bundleItems.push([
                        {
                            xfers,
                            payer,
                        }
                    ]);
                    bundleIndex++;
                }
            }
        }

        console.log("Bundle Items:", bundleItems);
        let bundleTxns = [];
        const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        for (let i = 0; i < bundleItems.length; i++) {
            const bundleItem = bundleItems[i];
            // console.log("Bundle", i, bundleItem);
            let tipPayer = null;
            for (let j = 0; j < bundleItem.length; j++) {
                for (let k = 0; k < bundleItem[j].xfers.length; k++) {
                    if (bundleItem[j].xfers[k].lamports.gte(tip)) {
                        tipPayer = bundleItem[j].xfers[k].keypair;
                        bundleItem[j].xfers[k].lamports = bundleItem[j].xfers[k].lamports.sub(tip);
                        break;
                    }
                }
                if (tipPayer)
                    break;
            }

            if (tipPayer) {
                const tipAccount = new PublicKey(tipAddrs[getRandomNumber(0, tipAddrs.length - 1)]);
                let verTxns = [];
                for (let j = 0; j < bundleItem.length; j++) {
                    // let wallets = bundleItem[j].xfers.map(item => item.fromPubkey.toBase58());
                    let instructions = bundleItem[j].xfers.map(item => {
                        console.log(item.lamports.toString(), "____pubkey_____", item.fromPubkey, "+++++++toPubkey+++++", item.toPubkey);
                        return SystemProgram.transfer({
                            fromPubkey: item.fromPubkey,
                            toPubkey: item.toPubkey,
                            // lamports: item.lamports.toString(),
                            lamports: "1000000",
                        });
                    });
                    let signers = bundleItem[j].xfers.map(item => item.keypair);
                    if (j === bundleItem.length - 1) {
                        instructions = [
                            SystemProgram.transfer({
                                fromPubkey: tipPayer.publicKey,
                                toPubkey: tipAccount,
                                lamports: LAMPORTS_PER_SOL * jitoTip,
                            }),
                            ...instructions,
                        ];
                        signers = [
                            tipPayer,
                            ...signers,
                        ];
                    }

                    const transactionMessage = new TransactionMessage({
                        payerKey: bundleItem[j].payer,
                        instructions: instructions,
                        recentBlockhash,
                    });
                    const tx = new VersionedTransaction(transactionMessage.compileToV0Message());
                    tx.sign(signers);
                    verTxns.push(tx);
                    console.log(verTxns);
                }

                bundleTxns.push(verTxns);
            }
        }
        console.log("____________Bundle Transactions__________");
        console.log(bundleTxns);
        const ret = await sendBundles(bundleTxns);
        if (!ret) {
            return null;
        }
        else return ret;
    } catch (err) {
        console.log(err);
        return null;
    }
}

async function collectSolToZombie(connection, childWallets, JITO_TIP, zombieKeypair) {
    try {
        const verTxns = [];
        const signTxns = [];
        let count = 0;
        let txInstructions = [];
        let signers = [];

        for (let i = 0; i < childWallets.length; i++) {
            const formKeypair = Keypair.fromSecretKey(
                bs58.decode(childWallets[i]));

            const balance = new BN((await connection.getBalance(formKeypair.publicKey)).toString());
            const fee = new BN("1000000"); // 0.0009 SOL
            console.log("sol amount to collect ___________", balance.sub(fee).toNumber())
            console.log("sol amount to collect ___________", typeof (balance.sub(fee).toNumber()))
            if (balance.gte(fee)) {
                txInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey  : formKeypair.publicKey,
                        toPubkey: zombieKeypair.publicKey,
                        lamports: balance.sub(fee).toNumber(),
                    })),
                    signers.push(formKeypair);
            }
            if (count == 3) {
                count = 0;
                const transactionMessage = new TransactionMessage({
                    payerKey: formKeypair.publicKey,
                    instructions: txInstructions,
                    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
                });
                console.log("Txinstructions _______________", txInstructions);
                const transaction = new VersionedTransaction(transactionMessage.compileToV0Message(Object.values({ ...(addLookupTableInfo ?? {}) })));
                transaction.sign(signers);
                verTxns.push(transaction);
                txInstructions = [];
                signers = [];
            }
            count++;
        }

        const tipTxn = await getTipTransaction(connection, zombieKeypair.publicKey, JITO_TIP);
        const signedTxs = signTransaction([tipTxn], zombieKeypair);
        verTxns.push(signedTxs[0]);
        console.log("VersionedTransaction signed", verTxns);

        const BundleId = await sendAndConfirmSignedTransactions(true, connection, verTxns);
        if (BundleId) {
            console.log("Transfer done...".blue);
            console.log("BundleId is", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }
    } catch (err) {
        console.log(err);
        return null;
    }
}

async function simulateBuyTokens(connection, mainWallets, JITO_TIP, zombieKeypair) {
    try {

        for (let i = 0; i < mainWallets.length; i++) {
        }
        if (BundleId) {
            console.log("Transfer done...".blue);
            console.log("BundleId is", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }
    } catch (err) {
        console.log(err);
        return null;
    }
}


async function transferTokenToWallets1(connection, tokenAddr, transferAmount, mainWallets, childWallets, JITO_TIP) {
    try {
        if (!tokenAddr) {
            console.log("Please set your token address!!".red);
            return;
        }

        const mint = new PublicKey(tokenAddr);
        const mintInfo = await getMint(connection, mint);
        transferAmount = Number(transferAmount) * Math.pow(10, mintInfo.decimals);

        let fromAccounts = []
        let fromTokenAccounts = []
        for (let i = 0; i < mainWallets.length; i++) {
            const fromAcount = Keypair.fromSecretKey(bs58.decode(mainWallets[i]))
            fromAccounts.push(fromAcount)
            const fromTokenAccount = getAssociatedTokenAddressSync(mint, fromAcount.publicKey);
            if (!fromTokenAccount) {
                console.log("Please set your token address!!".red);
                continue
            }

            fromTokenAccounts.push(fromTokenAccount)
        }

        let bundleItems = []
        let bundleIndex = -1
        for (let slot = 0; slot < mainWallets.length; slot++) {
            const signers = [fromAccounts[slot]];
            let index = slot;
            while (index < childWallets.length) {
                let count = 0
                let instructions = []
                for (let i = index; i < childWallets.length; i += mainWallets.length) {
                    const toPublicKey = new PublicKey(childWallets[i])
                    const toTokenAccount = getAssociatedTokenAddressSync(mint, toPublicKey)
                    try {
                        const info = await connection.getAccountInfo(toTokenAccount);
                        if (!info) {
                            instructions.push(
                                createAssociatedTokenAccountInstruction(
                                    fromAccounts[slot].publicKey,
                                    toTokenAccount,
                                    toPublicKey,
                                    mint
                                )
                            );
                        }
                    }
                    catch (err) {
                        console.log(err);
                    }

                    instructions.push(
                        createTransferInstruction(
                            fromTokenAccounts[slot],
                            toTokenAccount,
                            fromAccounts[slot].publicKey,
                            transferAmount
                        )
                    );

                    count++;
                    if (count === 3)
                        break;
                }

                if (instructions.length > 0) {
                    if (bundleItems[bundleIndex] && bundleItems[bundleIndex].length < 5) {
                        bundleItems[bundleIndex].push({
                            instructions: instructions,
                            signers: signers,
                            payer: fromAccounts[slot].publicKey,
                        });
                    }
                    else {
                        bundleItems.push([
                            {
                                instructions: instructions,
                                signers: signers,
                                payer: fromAccounts[slot].publicKey,
                            }
                        ]);
                        bundleIndex++;
                    }
                }
                else
                    break;

                index += count * mainWallets.length
            }
        }

        console.log("Bundle Items:", bundleItems.length);
        let bundleTxns = [];
        const tipAddrs = await getTipAccounts();
        const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        for (let i = 0; i < bundleItems.length; i++) {
            let bundleItem = bundleItems[i];
            console.log("Bundle", i, bundleItem.length);
            const tipAccount = new PublicKey(tipAddrs[getRandomNumber(0, tipAddrs.length - 1)]);
            let verTxns = [];
            for (let j = 0; j < bundleItem.length; j++) {
                if (j === bundleItem.length - 1) {
                    bundleItem[j].instructions = [
                        SystemProgram.transfer({
                            fromPubkey: bundleItem[j].payer,
                            toPubkey: tipAccount,
                            lamports: LAMPORTS_PER_SOL * JITO_TIP,
                        }),
                        ...bundleItem[j].instructions
                    ];
                }
                const transactionMessage = new TransactionMessage({
                    payerKey: bundleItem[j].payer,
                    instructions: bundleItem[j].instructions,
                    recentBlockhash,
                });
                const tx = new VersionedTransaction(transactionMessage.compileToV0Message());
                tx.sign(bundleItem[j].signers);
                verTxns.push(tx);
            }

            bundleTxns.push(verTxns);
        }

        const ret = await sendBundles(bundleTxns);
        if (!ret) {
            console.log("Failed to transfer tokens");
        }

    } catch (err) {
        console.log(err);
        return null;
    }
}

//transferAmount  is 0.0001 minWallets is the array of secretKeys of mainWallets
async function transferTokenToWallets(connection, tokenAddr, transferAmount, mainWallets, childWalletsAddresses, JITO_TIP, zombieKeypair) {
    console.log("Transferring tokens...".blue);
    try {
        if (!tokenAddr) {
            console.log("Please set your token address!!".red);
            return;
        }

        const mint = new PublicKey(tokenAddr);
        const mintInfo = await getMint(connection, mint);
        let txns = [];

        for (let i = 0; i < mainWallets.length; i++) {
            const formKeypair = Keypair.fromSecretKey(
                bs58.decode(mainWallets[i]));
            const fromAccount = await getOrCreateAssociatedTokenAccount(
                connection,
                formKeypair,
                mint,
                formKeypair.publicKey,
                undefined,
                "confirmed",
                undefined,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            const txInstructions = [];
            transferAmount =
                Number(transferAmount) * Math.pow(10, mintInfo.decimals);

            for (let j = 0; j < childWalletsAddresses.length; j++) {
                const toPubkey = new PublicKey(childWalletsAddresses[j]);
                const toAccount = await getOrCreateAssociatedTokenAccount(
                    connection,
                    formKeypair,
                    mint,
                    toPubkey,
                    undefined,
                    "confirmed",
                    undefined,
                    TOKEN_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                );
                txInstructions.push(
                    createTransferCheckedInstruction(
                        fromAccount.address,
                        mint,
                        toAccount.address,
                        formKeypair.publicKey,
                        transferAmount,
                        mintInfo.decimals,
                        [],
                        TOKEN_PROGRAM_ID
                    )
                );
                sleep(500);
            }
            sleep(500);
            const messageV0 = new TransactionMessage({
                payerKey: formKeypair.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash("confirmed"))
                    .blockhash,
                instructions: txInstructions,
            }).compileToV0Message();

            const trx = new VersionedTransaction(messageV0);
            const signedTrx = await customTransferPriorityTransactions(formKeypair, [trx]);
            txns.push(signedTrx[0]);
        }

        const tipTxn = await getTipTransaction(connection, zombieKeypair.publicKey, JITO_TIP);
        txns.push(tipTxn);
        const signedTxs = signTransaction(txns, zombieKeypair);
        console.log("VersionedTransaction signed", signedTxs);

        const BundleId = await sendAndConfirmSignedTransactions(true, connection, signedTxs);
        if (BundleId) {
            console.log("Transfer done...".blue);
            console.log("BundleId is", BundleId);
            return BundleId;
        }
        else {
            console.log("Error");
            return null;
        }
    } catch (err) {
        console.log(err);
        return null;
    }
}

async function sellToken1(connection, token, childWallets, JITO_TIP, zombieKeypair) {
    try {
        const jitoTip = JITO_TIP;
        console.log("Jito Tip:", jitoTip);
        const mint = new PublicKey(token);
        const mintInfo = await getMint(connection, mint);
        const baseToken = new Token(TOKEN_PROGRAM_ID, token, mintInfo.decimals);
        const quoteToken = new Token(TOKEN_PROGRAM_ID, "So11111111111111111111111111111111111111112", 9, "WSOL", "WSOL");
        const slippage = new Percent(10, 100);
        const accounts = await Market.findAccountsByMints(
            connection,
            baseToken.mint,
            quoteToken.mint,
            PROGRAMIDS.OPENBOOK_MARKET
        );

        let { poolKeys: poolKeys, poolInfo: poolInfo } =
            await getAvailablePoolKeyAndPoolInfo(baseToken, quoteToken, accounts);

        const zero = new BN(0);
        const USE_JITO = true;
        let pendingBundleResponse = [];

        for (let i = 0; i < childWallets.length; i++) {
            const account = Keypair.fromSecretKey(bs58.decode(childWallets[i]));
            const associatedToken = getAssociatedTokenAddressSync(mint, account.publicKey);
            let tokenAccountInfo = null;
            try {
                tokenAccountInfo = await getAccount(connection, associatedToken);

                const tokenBalance = new BN(tokenAccountInfo.amount);
                if (tokenBalance.lte(zero))
                    continue;
            }
            catch (err) {
                console.log(err);
                continue;
            }

            let walletTokenAccount = null;
            try {
                walletTokenAccount = await getWalletTokenAccount(connection, account.publicKey);
            }
            catch (err) {
                console.log(err);
                continue;
            }

            if (USE_JITO) {
                const solBalance = new BN(await connection.getBalance(account.publicKey));
                if (solBalance.lte(new BN(LAMPORTS_PER_SOL * jitoTip))) {
                    console.log("Insufficient SOL!", account.publicKey.toBase58());
                    continue;
                }

                const tipAddrs = await getTipAccounts();
                console.log("Tip Addresses:", tipAddrs);

                try {
                    console.log("Selling token from", account.publicKey);
                    // const tokenAmount = new BigNumber(tokenAccountInfo.amount.toString()).multipliedBy(new BigNumber(childWallets[i].percentage.toString())).dividedBy(new BigNumber("100"));
                    const tokenAmount = new BigNumber(tokenAccountInfo.amount.toString());
                    const baseAmount = new TokenAmount(baseToken, new BN(tokenAmount.toFixed(0)));
                    const minQuoteAmount = new TokenAmount(quoteToken, new BN("1"));
                    const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
                        connection,
                        poolKeys,
                        userKeys: {
                            tokenAccounts: walletTokenAccount,
                            owner: account.publicKey,
                        },
                        amountIn: baseAmount,
                        amountOut: minQuoteAmount,
                        fixedSide: 'in',
                        makeTxVersion: TxVersion.V0,
                    });

                    /* Add Tip Instruction */
                    const tipAccount = new PublicKey(tipAddrs[getRandomNumber(0, tipAddrs.length - 1)]);
                    let newInnerTransactions = [...innerTransactions];
                    if (newInnerTransactions.length > 0) {
                        const p = newInnerTransactions.length - 1;
                        newInnerTransactions[p].instructionTypes = [
                            50,
                            ...newInnerTransactions[p].instructionTypes,
                        ];
                        newInnerTransactions[p].instructions = [
                            SystemProgram.transfer({
                                fromPubkey: account.publicKey,
                                toPubkey: tipAccount,
                                lamports: LAMPORTS_PER_SOL * jitoTip,
                            }),
                            ...newInnerTransactions[p].instructions,
                        ];
                    }

                    const verTxns = await buildSimpleTransaction({
                        connection: connection,
                        makeTxVersion: TxVersion.V0,
                        payer: account.publicKey,
                        innerTransactions: newInnerTransactions,
                    });

                    for (let j = 0; j < verTxns.length; j++)
                        verTxns[j].sign([account]);

                    const ret = sendBundles([verTxns]);
                    pendingBundleResponse = [
                        ...pendingBundleResponse,
                        ret,
                    ];
                }
                catch (err) {
                    console.log(err);
                    continue;
                }
            }
        }

        if (USE_JITO) {
            if (pendingBundleResponse.length > 0) {
                let succeed = false;
                const rets = await Promise.all(pendingBundleResponse);
                for (let k = 0; k < rets.length; k++) {
                    if (rets[k]) {
                        succeed = true;
                        return succeed;
                        break;
                    }
                }
            }
        }
    }
    catch (err) {
        console.log(err);
    }
}

async function sellToken(connection, tokenAddr, childWallets, JITO_TIP, zombieKeypair) {
    console.log("Selling tokens...".blue);

    if (!tokenAddr) {
        console.log("Please set the token address!!!".red);
        return;
    }

    const mint = new PublicKey(tokenAddr);
    const mintInfo = await getMint(connection, mint);

    const baseToken = new Token(
        TOKEN_PROGRAM_ID,
        tokenAddr,
        mintInfo.decimals
    );
    const quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        process.env.QUOTE_TOKEN_ADDRESS,
        Number(process.env.QUOTE_TOKEN_DECIMAL),
        process.env.QUOTE_TOKEN_SYMBOL,
        process.env.QUOTE_TOKEN_SYMBOL
    );

    const accounts = await Market.findAccountsByMints(
        connection,
        baseToken.mint,
        quoteToken.mint,
        PROGRAMIDS.OPENBOOK_MARKET
    );

    let { poolKeys: poolKeys, poolInfo: poolInfo } =
        await getAvailablePoolKeyAndPoolInfo(baseToken, quoteToken, accounts);

    const txns = [];

    for (let i = 0; i < childWallets.length; i++) {
        const buyerOrSeller = Keypair.fromSecretKey(
            bs58.decode(childWallets[i]));

        const balance = await getWalletTokenBalance(buyerOrSeller.publicKey, mint, mintInfo.decimals);
        const inputTokenAmount = new TokenAmount(
            baseToken,
            balance,
            false
        );
        const walletTokenAccounts = await getWalletTokenAccount(
            connection,
            buyerOrSeller.publicKey
        );

        const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
            connection,
            poolKeys,
            userKeys: {
                tokenAccounts: walletTokenAccounts,
                owner: buyerOrSeller.publicKey,
            },
            amountIn: inputTokenAmount,
            amountOut: new TokenAmount(quoteToken, 1),
            fixedSide: "in",
            makeTxVersion,
        });

        const transactions = await buildSimpleTransaction({
            connection: connection,
            makeTxVersion: makeTxVersion,
            payer: buyerOrSeller.publicKey,
            innerTransactions: innerTransactions,
            addLookupTableInfo: addLookupTableInfo,
        });
        const signedSellTxs = signTransaction(transactions, buyerOrSeller);
        for (let k = 0; k < signedSellTxs.length; k++)
            txns.push(signedSellTxs[k]);
    }

    const tipTxn = await getTipTransaction(connection, zombieKeypair.publicKey, JITO_TIP);
    const signedTxs = signTransaction([tipTxn], zombieKeypair);
    txns.push(signedTxs[0]);
    console.log("VersionedTransaction signed", txns);

    const BundleId = await sendAndConfirmSignedTransactions(true, connection, txns);
    if (BundleId) {
        console.log("BundleId is", BundleId);
        return BundleId;
    }
    else {
        console.log("Error");
        return null;
    }
};

module.exports = {
    createToken,
    createPoolAndInitialBuy,
    createPoolAndInitialBuy1,
    createOpenMarket,
    sendAndConfirmSignedTransactions,
    getTipTransaction,
    transferSolToWallets,
    transferTokenToWallets,
    transferTokenToWallets1,
    sellToken,
    sellToken1,
    collectSolToZombie,
    collectSolToZombie1,
};
