// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IZapTokenFactory {
    function launchpad() external view returns (address);

    function deploy(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator,
        bytes32 userSalt
    ) external returns (address token);

    function tokenInitCodeHash(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply,
        address creator
    ) external view returns (bytes32);

    function predictTokenAddress(
        address creator,
        bytes32 userSalt,
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 supply
    ) external view returns (address);
}

interface IZapFeeVaultFactory {
    function launchpad() external view returns (address);

    function deploy(
        string calldata name,
        string calldata symbol,
        address creator,
        address protocolTreasury,
        address launchToken,
        address pairedAsset,
        address positionManager,
        uint16 creatorShareBps
    ) external returns (address vault);
}
