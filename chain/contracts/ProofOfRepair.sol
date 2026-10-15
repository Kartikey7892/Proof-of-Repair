// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ProofOfRepair
 * @notice Anchors Merkle roots of batched Repair Proofs for second-hand vehicles (VIN-bound).
 * @dev Inspired by BladeChain (off-chain evidence + on-chain hash) and DeviceStamp
 *      (lifecycle event anchoring). Only roots / metadata URIs are stored on-chain.
 *
 * References:
 *  - Hafez et al., BladeChain, Scientific Reports 2026
 *  - DeviceStamp Protocol whitepaper
 *  - IETF draft-reilly-sentinel-protocol (Merkle roll-up anchoring)
 */
contract ProofOfRepair {
    address public owner;

    struct Anchor {
        bytes32 merkleRoot;
        uint256 anchoredAt;
        string batchId;
        string metaURI; // off-chain URI to batch manifest / OTS receipt
        address submitter;
    }

    // merkleRoot => Anchor
    mapping(bytes32 => Anchor) public anchors;
    // batchId => merkleRoot (one root per batch id)
    mapping(string => bytes32) public batchRoot;

    event MerkleRootAnchored(
        bytes32 indexed merkleRoot,
        string batchId,
        string metaURI,
        address indexed submitter,
        uint256 anchoredAt
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Anchor a Merkle root for a batch of Proof-of-Repair leaves.
     * @param merkleRoot Root hash of the batch Merkle tree
     * @param batchId Unique batch identifier (e.g. date or UUID)
     * @param metaURI URI or CID of off-chain manifest / receipt
     */
    function anchorMerkleRoot(
        bytes32 merkleRoot,
        string calldata batchId,
        string calldata metaURI
    ) external returns (bool) {
        require(merkleRoot != bytes32(0), "empty root");
        require(bytes(batchId).length > 0, "empty batchId");
        require(anchors[merkleRoot].anchoredAt == 0, "root already anchored");
        require(batchRoot[batchId] == bytes32(0), "batch already used");

        anchors[merkleRoot] = Anchor({
            merkleRoot: merkleRoot,
            anchoredAt: block.timestamp,
            batchId: batchId,
            metaURI: metaURI,
            submitter: msg.sender
        });
        batchRoot[batchId] = merkleRoot;

        emit MerkleRootAnchored(
            merkleRoot,
            batchId,
            metaURI,
            msg.sender,
            block.timestamp
        );
        return true;
    }

    function isRootAnchored(bytes32 merkleRoot) external view returns (bool) {
        return anchors[merkleRoot].anchoredAt != 0;
    }

    function getAnchor(bytes32 merkleRoot)
        external
        view
        returns (
            bytes32 root,
            uint256 anchoredAt,
            string memory batchId,
            string memory metaURI,
            address submitter
        )
    {
        Anchor memory a = anchors[merkleRoot];
        require(a.anchoredAt != 0, "not found");
        return (a.merkleRoot, a.anchoredAt, a.batchId, a.metaURI, a.submitter);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
