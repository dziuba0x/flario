// Smart Accounts tool: get_smart_account_info
//
// Every XRPL account maps deterministically to a Flare address through the
// MasterAccountController, whether or not that account has actually been
// deployed yet. Both directions are real view functions in the official
// periphery artifacts:
//
//   getPersonalAccount(string xrplOwner) -> address
//   isSmartAccount(address)              -> (bool, string xrplOwner)
//
// An earlier version guessed at a `getFlareAddress` function that does not
// exist and degraded to a "coming soon" placeholder. This reads the published
// interface instead, so the tool returns a real answer.
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";
import { getClient, type NetworkType } from "../utils/rpc.js";
import { getContractAddress, getInterfaceAbi } from "../utils/contracts.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export const getSmartAccountInfoInput = {
  xrpl_address: z
    .string()
    .startsWith("r")
    .optional()
    .describe("XRPL account (r...). Resolves forward to its Flare address."),
  flare_address: z
    .string()
    .startsWith("0x")
    .optional()
    .describe("Flare address (0x...). Resolves backward to its XRPL owner."),
  network: z.enum(["mainnet", "coston2"]),
};

export async function getSmartAccountInfo(args: {
  xrpl_address?: string;
  flare_address?: string;
  network: NetworkType;
}) {
  const { xrpl_address, flare_address, network } = args;

  if (!xrpl_address && !flare_address) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Pass either xrpl_address (r...) to resolve forward, or flare_address (0x...) to resolve backward.",
        },
      ],
    };
  }

  try {
    const client = getClient(network);
    const controller = getAddress(
      await getContractAddress("MasterAccountController", network),
    );
    const abi = getInterfaceAbi("IMasterAccountController", network);

    const sourceId = (await client.readContract({
      address: controller,
      abi,
      functionName: "getSourceId",
    })) as `0x${string}`;

    // Reverse: Flare address -> XRPL owner.
    if (flare_address) {
      if (!isAddress(flare_address)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `"${flare_address}" is not a valid EVM address.`,
            },
          ],
        };
      }
      const address = getAddress(flare_address);
      const [isSmartAccount, xrplOwner] = (await client.readContract({
        address: controller,
        abi,
        functionName: "isSmartAccount",
        args: [address],
      })) as [boolean, string];

      return json({
        query: "reverse",
        flare_address: address,
        is_smart_account: isSmartAccount,
        xrpl_owner: isSmartAccount ? xrplOwner : null,
        network,
        controller,
        source_id: decodeSourceId(sourceId),
        note: isSmartAccount
          ? "This address is a deployed Smart Account controlled by the XRPL owner above."
          : "This address is not a Smart Account. It is an ordinary EVM address as far as the MasterAccountController is concerned.",
      });
    }

    // Forward: XRPL account -> deterministic Flare address.
    const personalAccount = (await client.readContract({
      address: controller,
      abi,
      functionName: "getPersonalAccount",
      args: [xrpl_address as string],
    })) as string;

    const mapped =
      personalAccount && getAddress(personalAccount) !== ZERO_ADDRESS
        ? getAddress(personalAccount)
        : null;

    // The mapping is deterministic and exists before deployment, so a non-zero
    // address does NOT mean the account is live on-chain. Bytecode does.
    let deployed = false;
    if (mapped) {
      const code = await client.getCode({ address: mapped });
      deployed = code !== undefined && code !== "0x";
    }

    return json({
      query: "forward",
      xrpl_address,
      flare_address: mapped,
      deployed,
      network,
      controller,
      source_id: decodeSourceId(sourceId),
      note: mapped
        ? deployed
          ? "Smart Account is deployed and live on Flare."
          : "Address is reserved deterministically but no contract is deployed there yet. It becomes live on first use."
        : "The controller returned the zero address for this XRPL account.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to read Smart Account info on ${network}: ${message}`,
        },
      ],
    };
  }
}

function json(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** bytes32 source id is an ASCII tag ("XRP") right-padded with zero bytes. */
function decodeSourceId(sourceId: `0x${string}`): string {
  const hex = sourceId.slice(2).replace(/(00)+$/, "");
  const bytes = hex.match(/.{1,2}/g) ?? [];
  return bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join("");
}
