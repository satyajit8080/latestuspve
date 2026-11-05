# Quant theory cheat sheet (personal notes)

Condensed from a one-page infographic by @RitOnchain ("the entire quant theory on one sheet"), rewritten as notes.
Transcribed by hand from an image: small errors in formulas or numbers are possible, so verify before relying on one.

## How to use it for Options Desk
The levels that decide whether our backtest is real are **2** (is it noise?), **5** (time series), **8** (Sharpe, sizing), **9** (costs) and **10** (not fooling yourself).
Order from the sheet: beginner 1→2→3→4 then one backtest; systematic trader 5→8→9→10; options trader add 6→7 then 8; researcher all ten. Level 10 decides if any of it is real.

## Level 1: probability
- Bayes: P(A|B) = P(B|A)P(A)/P(B). A 99%-accurate test with 1% prevalence: a positive means P(sick) = 50%.
- Linearity: E[X+Y] = E[X]+E[Y] even if dependent. Shuffle n cards: expected cards in own spot = 1.
- Variance: Var(X) = E[X²] − E[X]²; Var(X+Y) = VarX + VarY + 2Cov. One fair die: 35/12 ≈ 2.92.
- Total expectation: E[X] = E[E[X|Y]]. Expected rolls to the first 6 = 6.
- Distributions: Geometric E = 1/p; Poisson P(k) = λ^k e^−λ / k!; Normal 68/95/99.7. Rolls to see all 6 faces ≈ 14.7.

## Level 2: statistics (is it real or noise?)
- Standard error SE = σ/√n. Halving error needs 4x the data.
- t-stat of a Sharpe: t ≈ SR × √T. Monthly SR 0.2 over 36 months gives t ≈ 1.2 (not significant). Annual Sharpe 1 over 4 years: t = 2 (borderline).
- OLS: β = (XᵀX)⁻¹Xᵀy.
- Correlation ρ = Cov/(σxσy); R² = 1 − SSres/SStot. A tiny R² can still be a tradable edge. Corr(X, X²) = 0 for symmetric X, yet they are dependent.
- Multiple testing: P(≥1 false win) = 1 − (1−α)^k. 20 tests at 5% give a 64% chance of a fake winner. So the best backtest is overstated.

## Level 3: linear algebra
- Covariance matrix Σᵢⱼ = Cov(rᵢ, rⱼ); must be positive semi-definite.
- Portfolio variance σp² = wᵀΣw. Two assets, 20% vol, ρ = 0.5, 50/50: 17.3% vol. Adding an asset lowers risk when ρ < 1.
- PCA: Σ = QΛQᵀ. The first component of stocks is roughly "the market". Yield curve: level, slope, curvature.
- Conditioning κ = λmax/λmin; a large κ makes Σ⁻¹ blow up errors (optimizers go unstable with 500 assets).
- Shrinkage (Ledoit-Wolf): Σ* = δF + (1−δ)S. Blend the noisy sample with a simple target (bias-variance trade-off).

## Level 4: calculus and optimisation
- Taylor: f(x+h) ≈ f + f′h + ½f″h². Option P&L ≈ Δ·dS + ½Γ·dS² + Θ·dt. √101 ≈ 10.05.
- Gradient descent: θ ← θ − η∇L. Too big a learning rate diverges.
- Lagrange: ∇f = λ∇g. Maximise xy with x+y = 10: 25.
- Mean-variance weights: w* = (1/γ)Σ⁻¹μ; it piles into estimation errors.
- Jensen: E[f(X)] ≥ f(E[X]) for convex f. Volatility drag: growth ≈ mean − σ²/2 (10% mean, 20% vol: about 8%). +50% then −50% = −25%.

## Level 5: time series
- Log returns r = ln(Pt/Pt−1); they add over time. 1% daily vol ≈ 15.9% a year.
- Autocorrelation ρk = Corr(rt, rt−k): positive = momentum, negative = mean reversion.
- Stationarity (ADF): only stationary spreads can be traded for reversion. Prices are not stationary; returns roughly are.
- Cointegration: s = ln A − β ln B; half-life = −ln2/λ. λ ≈ −0.05 gives about a 13.9-day half-life. Correlation ≠ cointegration.
- GARCH(1,1): σt² = ω + αεt−1² + βσt−1². Volatility clusters. Long-run variance = ω/(1−α−β).

## Level 6: stochastic calculus
- Random walk: Var = nσ²; distance grows with √time. 100 fair ±1 steps: typical distance 10.
- Brownian motion: Wt ~ N(0, t), (dW)² = dt.
- GBM: dS = μS dt + σS dW; S = S₀·exp((μ − σ²/2)t + σWt). A GBM price can never go negative.
- Itô: df = (ft + μS fS + ½σ²S² fSS)dt + σS fS dW. Source of volatility drag; used to derive Black-Scholes.
- Martingales and gambler's ruin: in a fair game no betting system has an edge. Start 30, stop at 100 or 0: 30% to win. Doubling after losses does not beat a fair game.

## Level 7: derivatives
- Black-Scholes: C = S·N(d₁) − K·e^−rT·N(d₂). S = K = 100, r = 5%, σ = 20%, T = 1: call ≈ 10.45.
- Put-call parity: C − P = S − K·e^−rT (put ≈ 5.57 in that example). Violations are arbitrage.
- Greeks: Δ = ∂V/∂S, Γ = ∂²V/∂S², Θ = ∂V/∂t, ν = ∂V/∂σ. Gamma is highest at the money near expiry.
- Implied vol: σ such that BS(σ) = market price. The smile exists because the model's assumptions fail.
- Gamma P&L ≈ ½Γ S² (σ²realized − σ²implied) dt. Long gamma = long realised vol.

## Level 8: portfolio and risk
- CAPM: E[R] = rf + β(E[Rm] − rf), β = Cov(Ri, Rm)/Var(Rm). Separates alpha from market exposure.
- Fama-French: Ri − rf = α + β·MKT + s·SMB + h·HML + ε. Check that "alpha" is not a size or value tilt.
- Sharpe: SR = (R − rf)/σ; SRyear = SRday × √252. Daily 0.1 ≈ 1.59 a year.
- Kelly: f* = (bp − q)/b, or (μ − r)/σ². p = 0.55 at even odds: bet 10%; most pros bet half. Full Kelly is dangerous in practice.
- VaR (95%) = 1.645σ√t; ES is the average loss beyond it; max drawdown = worst peak-to-trough. $1M, 2% daily vol: VaR ≈ $32.9k, ES ≈ $41.3k.

## Level 9: microstructure and execution
- Mid = (bid + ask)/2; spread = ask − bid (in bps of mid). Every round trip pays the spread.
- Order-book imbalance I = Q(bid)/(Q(bid) + Q(ask)): a short-term direction signal.
- Square-root impact: ΔP/P ≈ Y·σ·√(Q/V). Trading 1% of daily volume with Y = 1, σ = 2%: about 0.2% impact. Split large orders.
- VWAP = Σpq/Σq; TWAP = equal slices; shortfall = paper P&L − real P&L. Benchmarks for execution quality.
- Avellaneda-Stoikov: reservation price r = s − qγσ²(T − t); skew quotes to shed inventory.

## Level 10: research and ML
- Backtest biases: look-ahead, survivorship, data snooping, missing costs. Signal at t trades at t+1.
- Walk-forward validation: train past, test the next block, roll; purge overlapping labels. Shuffled k-fold is wrong for time series.
- Deflated Sharpe: the Sharpe the luckiest of N worthless tries would show. N = 50, σ(SR) = 0.5: you must beat about 1.14. Testing 100 strategies makes the best one suspect.
- Precision = TP/(TP+FP), recall = TP/(TP+FN), F1 = 2PR/(P+R). 99% accuracy can still be a useless model (rare events).
- Regime models (HMM): hidden market states inferred from returns. Label regimes without look-ahead.

## Free resources listed on the sheet
MIT OCW 18.S096 (Math with Applications in Finance); 3Blue1Brown (Linear Algebra, Calculus); Khan Academy (Statistics and Probability); Kenneth French Data Library (factor data); StatQuest (stats and ML).
