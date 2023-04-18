export interface IToken {
    name: string;
    address: string;
    whale: string;
}

export interface ITokenPair {
    sellToken: IToken;
    buyToken: IToken;
    paths: string[];
    dex: string;
};
