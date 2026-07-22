const RPC = "https://rpc.mainnet.chain.robinhood.com";
const address = "0xdd90bfa4adc7f4401e611abac692d939f9f4cb07";

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

function decodeString(data) {
  const hex = data.slice(2);
  const offset = Number.parseInt(hex.slice(0, 64), 16) * 2;
  const length = Number.parseInt(hex.slice(offset, offset + 64), 16) * 2;
  return Buffer.from(hex.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
}

async function call(selector) {
  return rpc("eth_call", [{ to: address, data: selector }, "latest"]);
}

const [chainIdHex, bytecode, nameData, symbolData, decimalsData, totalSupplyData] = await Promise.all([
  rpc("eth_chainId", []),
  rpc("eth_getCode", [address, "latest"]),
  call("0x06fdde03"),
  call("0x95d89b41"),
  call("0x313ce567"),
  call("0x18160ddd"),
]);
const chainId = Number.parseInt(chainIdHex, 16);
const name = decodeString(nameData);
const symbol = decodeString(symbolData);
const decimals = Number(BigInt(decimalsData));
const totalSupplyRaw = BigInt(totalSupplyData);
const totalSupply = totalSupplyRaw / 10n ** BigInt(decimals);
const result = {
  chainId,
  address,
  deployedBytecode: bytecode !== "0x",
  name,
  symbol,
  decimals,
  totalSupplyRaw: totalSupplyRaw.toString(),
  totalSupply: totalSupply.toString(),
};
console.log(JSON.stringify(result, null, 2));
if (
  chainId !== 4663 ||
  !result.deployedBytecode ||
  name !== "OpenZaps" ||
  symbol !== "0xZAPS" ||
  decimals !== 18 ||
  totalSupply !== 100000000000n
) {
  process.exitCode = 1;
}
