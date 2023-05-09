import { IToken } from "./token";

export interface IPoolList {
    name: string;
    pools: IPool[];
}

export interface IPool {
    sellToken: IToken;
    buyToken: IToken;
    pools: string[];
}