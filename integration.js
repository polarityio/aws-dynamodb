'use strict';

const async = require('async');
const { DynamoDBClient, ExecuteStatementCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const get = require('lodash.get');
const { DateTime } = require('luxon');

const entityTemplateReplacementRegex = /{{entity}}/g;

let Logger;
let originalOptions = {};
let dbClient = null;

function startup(logger) {
  Logger = logger;
}

/**
 * Used to escape single quotes in entities and remove any newlines
 * @param entityValue
 * @returns {*}
 */
function escapeEntityValue(entityValue) {
  const escapedValue = entityValue
    .replace(/(\r\n|\n|\r)/gm, '')
    .replace(/\\/, '\\\\')
    .replace(/'/g, '\\');
  Logger.trace({ entityValue, escapedValue }, 'Escaped Entity Value');
  return escapedValue;
}

function createQuery(entity, options) {
  return {
    Statement: options.query,
    Parameters: [
      {
        S: options.queryParameter.replace(entityTemplateReplacementRegex, escapeEntityValue(entity.value))
      }
    ],
    Limit: options.limit
  };
}

function optionsHaveChanged(options) {
  if (
    originalOptions.region !== options.region ||
    originalOptions.endpoint !== options.endpoint ||
    originalOptions.accessKeyId !== options.accessKeyId ||
    originalOptions.secretAccessKey !== options.secretAccessKey
  ) {
    originalOptions = options;
    return true;
  }
  return false;
}

function summaryTagsOptionHasChanged(options) {
  if (originalOptions.summaryTags !== options.summaryTags) {
    originalOptions = options;
    return true;
  }

  return false;
}

function errorToPojo(err, detail) {
  return err instanceof Error
    ? {
        ...err,
        name: err.name,
        message: err.message,
        stack: err.stack,
        detail: detail ? detail : err.detail ? err.detail : 'Unexpected error encountered'
      }
    : err;
}

function parseAttribute(attribute, parser) {
  switch (parser) {
    case null:
      return attribute;
      break;
    case 'date-iso':
      return DateTime.fromISO(attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    case 'date-http':
      return DateTime.fromHTTP(attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    case 'date-rfc2822':
      return DateTime.fromRFC2822(attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    case 'date-sql':
      return DateTime.fromSQL(attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    case 'date-seconds':
      return DateTime.fromSeconds(+attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    case 'date-millis':
      return DateTime.fromSeconds(+attribute).toLocaleString(DateTime.DATETIME_SHORT);
      break;
    default:
      return attribute;
  }
}

/**
 * Takes the attribute option string which is a comma delimited list of attributes to display and converts
 * it into an object of the format:
 * ```
 * {
 *     label: <attribute label>,
 *     attribute: <attribute name>,
 *     parser: <attribute parser>
 * }
 * ```
 * The label is optional and is the display label to be used for the attribute.  If no label is provided then the
 * attribute name is used
 *
 * The attribute is the "name" of the attribute
 *
 * The parser is the parser to use if specified for converting the attribute value (currently supports various
 * date parsers since DynamoDB does not have date support).
 * then
 * @param attributeOption
 * @returns {*}
 */
function processAttributeOption(attributeOption) {
  const fields = attributeOption.split(',').map((column) => {
    const tokens = column.split(':');
    if (tokens.length === 1) {
      return {
        label: tokens[0].trim(),
        attribute: tokens[0].trim(),
        parser: null
      };
    } else if (tokens.length === 2) {
      return {
        label: tokens[0].trim(),
        attribute: tokens[1].trim(),
        parser: null
      };
    } else if (tokens.length === 3) {
      return {
        label: tokens[0].trim(),
        attribute: tokens[2].trim(),
        parser: tokens[1].trim().toLowerCase()
      };
    }
  });

  return fields;
}

function getDocumentTitle(result, options) {
  if (options.documentTitleAttribute.trim().length === 0) {
    return null;
  }

  const titleAttributes = processAttributeOption(options.documentTitleAttribute);

  if (titleAttributes[0]) {
    const attributeObj = titleAttributes[0];
    const attributeValue = get(result, attributeObj.attribute);
    const parsedValue = parseAttribute(attributeValue, attributeObj.parser);
    if (attributeObj.label) {
      return `${attributeObj.label}: ${parsedValue}`;
    } else {
      return parsedValue;
    }
  }

  return null;
}

function getDetails(results, options) {
  // If no detail attributes are specified then we just display the
  // whatever DynamoDB returns using the JSON viewer
  if (options.detailAttributes.trim().length === 0) {
    return {
      showAsJson: true,
      results
    };
  }

  const details = [];
  const detailAttributes = processAttributeOption(options.detailAttributes);

  results.forEach((result) => {
    const document = [];
    detailAttributes.forEach((attributeObj) => {
      const attributeValue = get(result, attributeObj.attribute);
      if (attributeValue) {
        document.push({
          key: attributeObj.label,
          value: parseAttribute(attributeValue, attributeObj.parser)
        });
      }
    });

    if (document.length > 0) {
      details.push({
        title: getDocumentTitle(result, options),
        attributes: document
      });
    }
  });

  return {
    showAsJson: false,
    results: details
  };
}

function getSummaryTags(results, options) {
  const tags = [];
  const summaryAttributes = processAttributeOption(options.summaryAttributes);

  summaryAttributes.forEach((attributeObj) => {
    results.forEach((result) => {
      const tag = get(result, attributeObj.attribute);
      if (tag) {
        if (attributeObj.label) {
          tags.push(`${attributeObj.label}: ${parseAttribute(tag, attributeObj.parser)}`);
        } else {
          tags.push(parseAttribute(tag, attributeObj.parser));
        }
      }
    });
  });

  if (tags.length === 0) {
    tags.push(`${result.length} ${result.length === 1 ? 'result' : 'results'}`);
  }
  return tags;
}

async function doLookup(entities, options, cb) {
  let lookupResults;

  if (optionsHaveChanged(options) || dbClient === null) {
    const clientOptions = {
      region: options.region.value,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    };
    Logger.trace({ clientOptions }, 'Creating new DynamoDB client');
    dbClient = new DynamoDBClient(clientOptions);
  }

  const searchTasks = entities.map((entity) => {
    return async () => {
      const query = new ExecuteStatementCommand(createQuery(entity, options));
      Logger.trace({ query }, 'search partiQL query');
      const result = await dbClient.send(query);
      if (Array.isArray(result.Items) && result.Items.length === 0) {
        return {
          entity,
          data: null
        };
      } else {
        // Convert from the dynamodb document to regular javascript object
        // https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_util_dynamodb.html#unmarshall-1
        const resultAsJson = result.Items.map(unmarshall);
        return {
          entity,
          data: {
            summary: getSummaryTags(resultAsJson, options),
            details: getDetails(resultAsJson, options)
          }
        };
      }
    };
  });

  try {
    lookupResults = await async.parallelLimit(searchTasks, 10);
  } catch (lookupError) {
    Logger.error(lookupError, 'doLookup error');
    return cb(errorToPojo(lookupError, 'Error running PartiQL query'));
  }

  Logger.trace({ lookupResults }, 'lookup results');

  cb(null, lookupResults);
}

module.exports = {
  doLookup,
  startup
};
