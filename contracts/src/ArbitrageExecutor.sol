// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Executes two-leg arbitrage via Morpho Blue flash loans on Base.
contract ArbitrageExecutor {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    mapping(address => bool) public allowedRouters;

    error NotOwner();
    error NotMorpho();
    error RouterNotAllowed();
    error SwapFailed(string leg);
    error InsufficientProfit(uint256 got, uint256 need);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Whitelist a DEX router so the callback can call it.
    function setRouter(address router, bool allowed) external onlyOwner {
        allowedRouters[router] = allowed;
    }

    /// @notice Initiate a flash loan arb. Only callable by owner.
    /// @param token  The token to borrow (e.g. USDC or WETH).
    /// @param amount The amount to borrow.
    /// @param data   ABI-encoded ArbParams for the callback.
    function execute(address token, uint256 amount, bytes calldata data) external onlyOwner {
        IMorpho(MORPHO).flashLoan(token, amount, data);
    }

    /// @notice Morpho flash loan callback — executes the two-leg swap.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO) revert NotMorpho();

        (
            address buyRouter,
            bytes memory buyCalldata,
            address sellRouter,
            bytes memory sellCalldata,
            address tokenIn,
            address tokenOut,
            uint256 minProfit
        ) = abi.decode(data, (address, bytes, address, bytes, address, address, uint256));

        if (!allowedRouters[buyRouter]) revert RouterNotAllowed();
        if (!allowedRouters[sellRouter]) revert RouterNotAllowed();

        // Buy leg: tokenIn → tokenOut
        IERC20(tokenIn).forceApprove(buyRouter, assets);
        (bool ok1,) = buyRouter.call(buyCalldata);
        if (!ok1) revert SwapFailed("buy");

        // Sell leg: tokenOut → tokenIn
        uint256 tokenOutBal = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenOut).forceApprove(sellRouter, tokenOutBal);
        (bool ok2,) = sellRouter.call(sellCalldata);
        if (!ok2) revert SwapFailed("sell");

        // Verify profit
        uint256 finalBal = IERC20(tokenIn).balanceOf(address(this));
        if (finalBal < assets + minProfit) revert InsufficientProfit(finalBal - assets, minProfit);

        // Approve Morpho to pull back the borrowed amount
        IERC20(tokenIn).forceApprove(MORPHO, assets);
    }

    /// @notice Withdraw accumulated profits.
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner, bal);
    }

    /// @notice Withdraw ETH if any.
    function withdrawETH() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok);
    }

    receive() external payable {}
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}
