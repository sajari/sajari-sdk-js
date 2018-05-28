/**
 * @fileOverview Exports the Sajari javascript api.
 * @name index.ts
 * @author Sajari
 * @license MIT
 * @module sajari
 */

import { Result, ResultValues, AggregateResponse, Results } from "./results";

import {
  valueFromProto,
  newResult,
  newAggregates,
  newResults
} from "./constructors";

const UserAgent = "sdk-js-1.0.0";

export interface Tracking {
  // Tracking specifies which kind (if any) tokens should be generated and returned
  // with the query results.
  type: TrackingType;

  // QueryID is a unique identifier for a single search query.  In the
  // case of live querying this is defined to be multiple individual queries
  // (i.e. as a user types the query is re-run).
  query_id: string;

  // Sequence (i.e. sequential identifier) of this  in the context of a
  // sequence of queries.
  sequence: number;

  // Field is the field to be used for adding identifier information to
  // generated tokens (see TrackingType).
  field: string;

  // Data are values which will be recorded along with tracking data produced
  // for the request.
  data: Values;
}

export interface Values {
  [id: string]: string;
}

export interface ISession {
  next(values: Values): [Tracking | undefined, Error | undefined];
  reset(): void;
}

export const TrackingNone: string = "NONE";
export const TrackingClick: string = "CLICK";
export const TrackingPosNeg: string = "POS_NEG";

export const enum TrackingType {
  TrackingNone = "NONE",
  TrackingClick = "CLICK",
  TrackingPosNeg = "POS_NEG"
}

// randString constructs a random string of 16 characters.
const randString = (): string => {
  let queryID = "";
  for (let i = 0; i < 16; i++) {
    queryID += "abcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 36)
    );
  }
  return queryID;
};

/**
 * TextSession creates a session based on text searches.
 * It automatically resets once the value specified by the query label has changed in certain ways.
 */
export class TextSession implements ISession {
  private queryLabel: string;
  private session: ISession;
  private lastQuery: string = "";

  public constructor(queryLabel: string, session: ISession) {
    this.queryLabel = queryLabel;
    this.session = session;
  }

  public next(values: Values): [Tracking | undefined, Error | undefined] {
    const text = values[this.queryLabel];
    if (text === undefined) {
      this.reset();
      return this.session.next(values);
    }

    const shortenedPrevQ = this.lastQuery.substr(0, Math.min(text.length, 3));
    const first3CharactersChanged = !(
      text.substr(0, shortenedPrevQ.length) === shortenedPrevQ
    );
    const queryCleared = this.lastQuery.length > 0 && text.length === 0;
    if (first3CharactersChanged || queryCleared) {
      this.reset();
    }
    this.lastQuery = text;

    return this.session.next(values);
  }

  public reset(): void {
    this.session.reset();
  }
}

export class Session implements ISession {
  private queryID: string = "";
  private sequence: number = 0;

  private trackingType: TrackingType;
  private field: string;
  private sessionData: Values;

  public constructor(trackingType: TrackingType, field: string, data: Values) {
    this.trackingType = trackingType;
    this.field = field;
    this.sessionData = data;
  }

  public next(values: Values): [Tracking | undefined, Error | undefined] {
    if (this.queryID === "") {
      this.queryID = randString();
      this.sequence = 0;
    } else {
      this.sequence++;
    }

    return [
      {
        type: this.trackingType,
        query_id: this.queryID,
        sequence: this.sequence,
        field: this.field,
        data: this.sessionData
      },
      undefined
    ];
  }

  public reset(): void {
    this.queryID = "";
    this.sequence = 0;
  }
}

export type Opt = (client: Client) => void;

export const withEndpoint = (endpoint: string) => (client: Client) => {
  client.endpoint = endpoint;
};

/**
 * Client takes configuration and constructs pipelines clients
 */
export class Client {
  public project: string;
  public collection: string;
  public endpoint: string;

  public constructor(project: string, collection: string, opts: Opt[] = []) {
    this.project = project;
    this.collection = collection;
    this.endpoint = "https://jsonapi.sajari.net/";
    opts.forEach(opt => {
      opt(this);
    });
  }

  /**
   * pipeline returns a new pipeline client
   */
  public pipeline(name: string): Pipeline {
    return new Pipeline(this, name);
  }
}

export interface SJError {
  message: string;
  code?: number;
}

const makeError = (message: string, code?: number): SJError => ({
  message,
  code
});

export interface Key {
  field: string;
  value: any;
}

export type SearchCallback = (
  error?: SJError,
  results?: Results,
  values?: Values
) => void;

export type AddCallback = (key: Key, error: SJError) => void;

export interface SJRecord {
  [id: string]: any;
}

/**
 * makeRequest makes a XMLHttpRequest and handles network and parsing errors.
 */
const makeRequest = (
  address: string,
  body: any,
  callback: (error?: SJError, response?: any) => void
): void => {
  const request = new XMLHttpRequest();
  request.open("POST", address, true);
  request.setRequestHeader("Accept", "application/json");
  request.onreadystatechange = () => {
    if (request.readyState !== 4) return;

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(request.responseText);
    } catch (e) {
      callback(makeError("error parsing response"), undefined);
      return;
    }

    if (request.status === 200) {
      callback(undefined, parsedResponse);
      return;
    }

    callback(makeError(parsedResponse.message, request.status), undefined);
  };

  request.send(body);
};

/**
 * Pipeline is a client for performing searches and adds on a collection.
 */
export class Pipeline {
  private client: Client;
  private name: string;

  /**
   * Create a pipeline
   */
  public constructor(client: Client, name: string) {
    this.client = client;
    this.name = name;
  }

  /**
   * Search runs a search query defined by a pipline with the given values and
   * tracking configuration. Calls the callback with the query results and returned values (which could have
   * been modified in the pipeline).
   */
  public search(
    values: Values,
    session: ISession,
    callback: SearchCallback
  ): void {
    const [tracking, error] = session.next(values);
    if (error) {
      callback(
        makeError("error getting next session: " + error),
        undefined,
        undefined
      );
      return;
    }

    const requestBody = JSON.stringify({
      request: {
        pipeline: { name: this.name },
        tracking,
        values
      },
      metadata: {
        project: [this.client.project],
        collection: [this.client.collection],
        "user-agent": [UserAgent]
      }
    });

    makeRequest(
      this.client.endpoint + "sajari.api.pipeline.v1.Query/Search",
      requestBody,
      (error?: SJError, response?: any) => {
        if (error !== undefined) {
          callback(error, undefined, undefined);
          return;
        }
        callback(
          undefined,
          newResults(response.searchResponse, response.tokens),
          response.values
        );
      }
    );
  }
}