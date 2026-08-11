import type { ProviderKind } from "@own-harness/contracts"
import type { HarnessConfig } from "./config.js"

export interface ModelPrice {
  readonly provider: ProviderKind
  readonly modelGlob: string
  readonly inputPerMillion: number
  readonly cacheReadInputPerMillion?: number
  readonly outputPerMillion: number
}

interface EstimatedCostBase {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokensIn: number
  readonly costUsd: number
  readonly currency: string
}

export interface PricedEstimatedCost extends EstimatedCostBase {
  readonly pricingStatus: "priced"
}

export interface UnpricedEstimatedCost extends EstimatedCostBase {
  readonly pricingStatus: "unpriced"
}

export type EstimatedCost = PricedEstimatedCost | UnpricedEstimatedCost

export interface PricingCatalog {
  readonly estimate: (options: {
    readonly provider: ProviderKind
    readonly model: string
    readonly tokensIn: number
    readonly tokensOut: number
    readonly cacheReadTokensIn: number
  }) => EstimatedCost
}

export function createPricingCatalog(config: HarnessConfig): PricingCatalog {
  const prices: ModelPrice[] = config.pricing.models.map((model) => ({
    provider: model.provider,
    modelGlob: model.model,
    inputPerMillion: model.inputPerMillion,
    ...(model.cacheReadInputPerMillion === undefined
      ? {}
      : { cacheReadInputPerMillion: model.cacheReadInputPerMillion }),
    outputPerMillion: model.outputPerMillion
  }))

  return {
    estimate: (options) => {
      if (options.cacheReadTokensIn > options.tokensIn) {
        throw new RangeError(
          `cacheReadTokensIn ${options.cacheReadTokensIn} exceeds tokensIn ${options.tokensIn}`
        )
      }
      const price = findPrice(prices, options.provider, options.model)
      if (price === undefined) {
        return {
          tokensIn: options.tokensIn,
          tokensOut: options.tokensOut,
          cacheReadTokensIn: options.cacheReadTokensIn,
          costUsd: 0,
          currency: config.pricing.defaultCurrency,
          pricingStatus: "unpriced"
        }
      }
      const cacheReadTokensIn = options.cacheReadTokensIn
      const cacheMissTokensIn = options.tokensIn - cacheReadTokensIn
      const cacheReadInputPerMillion = price.cacheReadInputPerMillion ?? price.inputPerMillion
      const costUsd =
        (cacheMissTokensIn / 1_000_000) * price.inputPerMillion +
        (cacheReadTokensIn / 1_000_000) * cacheReadInputPerMillion +
        (options.tokensOut / 1_000_000) * price.outputPerMillion
      return {
        tokensIn: options.tokensIn,
        tokensOut: options.tokensOut,
        cacheReadTokensIn,
        costUsd: roundMoney(costUsd),
        currency: config.pricing.defaultCurrency,
        pricingStatus: "priced"
      }
    }
  }
}

function findPrice(prices: ModelPrice[], provider: ProviderKind, model: string): ModelPrice | undefined {
  return prices.find((price) => price.provider === provider && globToRegExp(price.modelGlob).test(model))
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`)
}

function roundMoney(value: number): number {
  return Math.round(value * 10000) / 10000
}
