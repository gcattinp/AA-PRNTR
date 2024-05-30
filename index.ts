import { ENTRYPOINT_ADDRESS_V07, createSmartAccountClient, getRequiredPrefund, type UserOperation } from "permissionless"
import { signerToSafeSmartAccount } from "permissionless/accounts"
import {
  createPimlicoBundlerClient,
  createPimlicoPaymasterClient,
} from "permissionless/clients/pimlico"
import { createPublicClient, http, parseEther, getContract, type Hex, erc20Abi, type Address, createWalletClient, stringToHex, encodeFunctionData } from "viem"
import { arbitrum } from "viem/chains"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { neethAbi } from "./neethAbi"
import { factoryAbi } from "./factoryAbi"

const NEETH_ADDRESS = "0x00000000000009B4AB3f1bC2b029bd7513Fbd8ED" as const;
const FACTORY_ADDRESS = "0x53E60A0d769DD73CedF79041aE2cbB4f9af14a95" as const;
const API_KEY = process.env.PIMLICO_API_KEY;

let PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;

if (!PRIVATE_KEY) {
  PRIVATE_KEY = generatePrivateKey();
}

const pimlicoEndpoint = `https://api.pimlico.io/v2/arbitrum/rpc?apikey=${API_KEY}`;

export const publicClient = createPublicClient({
  transport: http("https://rpc.ankr.com/arbitrum/"),
})

export const paymasterClient = createPimlicoPaymasterClient({
  transport: http(`https://api.pimlico.io/v2/arbitrum/rpc?apikey=${API_KEY}`),
  entryPoint: ENTRYPOINT_ADDRESS_V07,
})

export const pimlicoBundlerClient = createPimlicoBundlerClient({
  transport: http(`https://api.pimlico.io/v2/arbitrum/rpc?apikey=${API_KEY}`),
  entryPoint: ENTRYPOINT_ADDRESS_V07,
})

const signer = privateKeyToAccount(PRIVATE_KEY);

console.log('Signer:', signer.address)

const walletClient = createWalletClient({
  account: signer,
  transport: http("https://rpc.ankr.com/arbitrum/"),
  chain: arbitrum,
})

const currentNonce = await publicClient.getTransactionCount({
  address: signer.address,
})

const factoryContract = getContract({
  address: FACTORY_ADDRESS,
  abi: factoryAbi,
  client: {
    public: publicClient,
    wallet: walletClient,
  }
})


const NEETHContract = getContract({
  address: NEETH_ADDRESS,
  abi: neethAbi,
  client: {
    public: publicClient,
    wallet: walletClient,
  }
})

const getNEETHBalanceEOA = await NEETHContract.read.balanceOf([signer.address])

console.log('NEETH Balance EOA:', getNEETHBalanceEOA)

const depositNEETH = await NEETHContract.write.deposit(
  {
    to: NEETH_ADDRESS,
    value: parseEther("0.0001"),
    nonce: currentNonce+1,
  }
)

const waitDepositNEETH = await publicClient.waitForTransactionReceipt(
  {
    hash: depositNEETH,
    retryDelay: 15_000
  }
)

console.log('Transaction Finished:', waitDepositNEETH)

const newEOABalance = await NEETHContract.read.balanceOf([signer.address])
console.log('New EOA Balance:', newEOABalance)

const SendNEETHToSCA = newEOABalance - getNEETHBalanceEOA;
console.log('Send NEETH to SCA:', SendNEETHToSCA)


const safeAccount = await signerToSafeSmartAccount(publicClient, {
  entryPoint: ENTRYPOINT_ADDRESS_V07,
  signer: signer,
  saltNonce: 0n, // optional
  safeVersion: "1.4.1",
  // address:, // optional, only if you are using an already created account
})

console.log('Safe Account:', safeAccount.address)

const depositTx = await walletClient.sendTransaction({
  to: safeAccount.address,
  value: parseEther("0.0001"),
  nonce: currentNonce+1,
  data: encodeFunctionData({
    abi: neethAbi,
    functionName: 'depositTo',
    args: [safeAccount.address],
  })
})

console.log('Deposit Tx:', depositTx)


const smartAccountClient = createSmartAccountClient({
  account: safeAccount,
  entryPoint: ENTRYPOINT_ADDRESS_V07,
  chain: arbitrum,
  bundlerTransport: http(pimlicoEndpoint),
  middleware: {
    gasPrice: async () => (await pimlicoBundlerClient.getUserOperationGasPrice()).fast, // if using pimlico bundler
    sponsorUserOperation: async (args: { userOperation: UserOperation<"v0.7">, entryPoint: Address }) => {
      // getRequiredPrefund
      const requiredPrefund = getRequiredPrefund({
        userOperation: {
          ...args.userOperation,
          paymaster: NEETH_ADDRESS
        },
        entryPoint: ENTRYPOINT_ADDRESS_V07
      })

      console.log('Required Prefund:', requiredPrefund)

      // check neeth balance
      const neethBalance = await publicClient.readContract({
        address: NEETH_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [safeAccount.address]
      })

      console.log('NEETH Balance:', neethBalance)

      if (neethBalance > requiredPrefund) {
        const gasEstimates = await pimlicoBundlerClient.estimateUserOperationGas({
          userOperation: { ...args.userOperation, paymaster: NEETH_ADDRESS },
        })

        console.log('Gas Estimates: (NEETH)', gasEstimates)

        return {
          ...gasEstimates,
          paymaster: NEETH_ADDRESS,
        }
      } else {
        const gasEstimates = await pimlicoBundlerClient.estimateUserOperationGas({
          userOperation: { ...args.userOperation, paymaster: '0x' },
        })

        console.log('Gas Estimates: (ETH)', gasEstimates)

        return {
          ...gasEstimates,
          paymaster: '0x'
        }
      }
    },
  },
})

const transferNEETHToSafe = await NEETHContract.write.transfer([
  safeAccount.address,
  SendNEETHToSCA,
], {nonce: currentNonce+1})

console.log('Transfer NEETH to Safe:', transferNEETHToSafe)

// Encode the transaction data for creating the token
// Change args as needed
const deployTokenData = encodeFunctionData({
  abi: factoryAbi,
  functionName: "createToken",
  args: ["Test Token", "TEST", 100000000000000000000n]
});

// Send the transaction through the smartAccountClient
const txHash = await smartAccountClient.sendTransaction({
  to: FACTORY_ADDRESS,
  data: deployTokenData,
  value: 0n,
});

console.log('Transaction Hash:', txHash)
