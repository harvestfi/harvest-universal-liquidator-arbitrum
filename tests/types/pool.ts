import { IToken } from "./token";

export interface IPool {
    sellToken: IToken;
    buyToken: IToken;
    poolIds: string[];
}