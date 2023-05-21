export interface IToken {
    name: string;
    address: string;
    whale?: string;
}

export interface ITokenPair {
    sellToken: IToken;
    buyToken: IToken;
    paths: string[];
    dex: string;
};

interface IPath {
    name: string;
    paths: string[];
}

export interface ICrossDexTokenPair {
    sellToken: IToken;
    buyToken: IToken;
    intermediate: string;
    dexes: IPath[];
    description: string;
}
