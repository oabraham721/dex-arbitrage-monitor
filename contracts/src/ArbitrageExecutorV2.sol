// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Executes N-leg arbitrage via Morpho Blue flash loans on Base.
contract ArbitrageExecutorV2 {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    mapping(address => bool) public allowedRouters;

    error NotOwner();
    error NotMorpho();
    error RouterNotAllowed(address router);
    error SwapFailed(uint256 leg);
    error InsufficientProfit(uint256 got, uint256 need);
    error LengthMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        allowedRouters[router] = allowed;
    }

    function execute(address token, uint256 amount, bytes calldata data) external onlyOwner {
        IMorpho(MORPHO).flashLoan(token, amount, data);
    }

    /// @notice Morpho callback — executes N sequential swaps and verifies profit.
    /// @dev data is abi.encode(routers, calldatas, tokenOuts, offsets, tokenIn, minProfit)
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO) revert NotMorpho();

        (
            address[] memory routers,
            bytes[] memory calldatas,
            address[] memory tokenOuts,
            uint256[] memory offsets,
            address tokenIn,
            uint256 minProfit
        ) = abi.decode(data, (address[], bytes[], address[], uint256[], address, uint256));

        uint256 n = routers.length;
        if (n != calldatas.length || n != tokenOuts.length || n != offsets.length) revert LengthMismatch();

        address currentToken = tokenIn;
        uint256 currentAmount = assets;

        for (uint256 i; i < n; ++i) {
            if (!allowedRouters[routers[i]]) revert RouterNotAllowed(routers[i]);

            IERC20(currentToken).forceApprove(routers[i], currentAmount);

            // Patch amountIn into calldata at the specified byte offset
            bytes memory sc = calldatas[i];
            uint256 offset = offsets[i];
            assembly { mstore(add(add(sc, 32), offset), currentAmount) }

            (bool ok,) = routers[i].call(sc);
            if (!ok) revert SwapFailed(i);

            currentToken = tokenOuts[i];
            currentAmount = IERC20(currentToken).balanceOf(address(this));
        }

        // Verify profit: last leg's tokenOut should be tokenIn
        uint256 required = assets + minProfit;
        if (currentAmount < required) {
            revert InsufficientProfit(currentAmount > assets ? currentAmount - assets : 0, required - currentAmount);
        }

        IERC20(tokenIn).forceApprove(MORPHO, assets);
    }

    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner, bal);
    }

    function withdrawETH() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok);
    }

    receive() external payable {}
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}
