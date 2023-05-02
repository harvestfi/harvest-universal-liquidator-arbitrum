import { IToken } from "./token";

export interface IFeePair {
    sellToken: IToken;
    buyToken: IToken;
    fee: number;
}