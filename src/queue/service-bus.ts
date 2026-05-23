import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusSender,
} from "@azure/service-bus";

let client: ServiceBusClient | null = null;

function readConnectionString() {
  return (process.env.AZURE_SERVICEBUS_CONNECTION_STRING || "").trim();
}

function requireConnectionString() {
  const connectionString = readConnectionString();
  if (!connectionString) {
    throw new Error("Falta AZURE_SERVICEBUS_CONNECTION_STRING para usar Azure Service Bus.");
  }
  return connectionString;
}

function getClient() {
  if (!client) {
    client = new ServiceBusClient(requireConnectionString());
  }
  return client;
}

export function getServiceBusQueueNames() {
  return {
    jobsQueueName: (process.env.JOBS_QUEUE_NAME || "llm-jobs").trim() || "llm-jobs",
    resultsQueueName: (process.env.RESULTS_QUEUE_NAME || "llm-results").trim() || "llm-results",
  };
}

export function createJobsSender(): ServiceBusSender {
  return getClient().createSender(getServiceBusQueueNames().jobsQueueName);
}

export function createJobsReceiver(): ServiceBusReceiver {
  return getClient().createReceiver(getServiceBusQueueNames().jobsQueueName);
}

export function createResultsSender(): ServiceBusSender {
  return getClient().createSender(getServiceBusQueueNames().resultsQueueName);
}

export function createResultsReceiver(): ServiceBusReceiver {
  return getClient().createReceiver(getServiceBusQueueNames().resultsQueueName);
}

export async function closeServiceBusClient() {
  if (!client) return;
  const current = client;
  client = null;
  await current.close();
}
