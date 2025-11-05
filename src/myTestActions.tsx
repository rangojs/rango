'use server'

// Server-side state for the test page
let testPageVisits = 0
let lastVisitor = 'No one yet'
let messages: string[] = []

export async function getTestPageStats() {
  return {
    visits: testPageVisits,
    lastVisitor,
    messageCount: messages.length
  }
}

export async function incrementTestPageVisits(visitorName?: string) {
  testPageVisits++
  if (visitorName) {
    lastVisitor = visitorName
  }
  return testPageVisits
}

export async function addMessage(message: string) {
  // Add message with timestamp
  const timestamp = new Date().toLocaleTimeString()
  messages.push(`[${timestamp}] ${message}`)

  // Keep only last 5 messages
  if (messages.length > 5) {
    messages = messages.slice(-5)
  }

  return messages
}

export async function getMessages() {
  return messages
}

export async function clearMessages() {
  messages = []
  return true
}

export async function performServerCalculation(num1: number, num2: number, operation: string) {
  // This calculation happens entirely on the server
  await new Promise(resolve => setTimeout(resolve, 500)) // Simulate processing

  let result: number
  switch (operation) {
    case 'add':
      result = num1 + num2
      break
    case 'multiply':
      result = num1 * num2
      break
    case 'power':
      result = Math.pow(num1, num2)
      break
    default:
      result = num1 + num2
  }

  return {
    calculation: `${num1} ${operation} ${num2}`,
    result,
    processedOn: 'server',
    timestamp: new Date().toISOString()
  }
}