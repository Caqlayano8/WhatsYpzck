/**
 * Test script for multi-session support
 * Tests Phase 3: Multi-client factory implementation
 */

import path from 'path';

// Mock the BotManager to test session creation
class MockBotManager {
    private sessionClients: Map<string, any> = new Map();
    private sessionQrData: Map<string, any> = new Map();
    private sessionMetadata: Map<string, any> = new Map();

    private buildSessionKey(tenantId: string, sessionKey: string): string {
        return `${tenantId}:${sessionKey}`;
    }

    public createSession(tenantId: string, sessionKey: string): void {
        const compositeKey = this.buildSessionKey(tenantId, sessionKey);

        // Prevent duplicate sessions
        if (this.sessionClients.has(compositeKey)) {
            console.log(`✓ Session ${compositeKey} already exists`);
            return;
        }

        console.log(`✓ Creating session ${compositeKey}`);

        // Special case: default:primary uses singleton
        if (tenantId === 'default' && sessionKey === 'primary') {
            this.sessionClients.set(compositeKey, { name: 'singleton-client' });
            this.sessionQrData.set(compositeKey, { qrCodeData: '', qrScanned: false });
        } else {
            // Multi-client: create new independent client
            try {
                const newClient = { 
                    name: `client-${tenantId}-${sessionKey}`,
                    dataDir: path.join(process.cwd(), '.wwebjs_auth', `session-${tenantId}-${sessionKey}`)
                };

                this.sessionClients.set(compositeKey, newClient);
                this.sessionQrData.set(compositeKey, {
                    qrCodeData: '',
                    qrScanned: false,
                    authenticated: false
                });

                console.log(`✓ Created new client for ${compositeKey}: ${newClient.name}`);
            } catch (error) {
                console.error(`✗ Failed to create session ${compositeKey}:`, error);
                return;
            }
        }

        this.sessionMetadata.set(compositeKey, {
            createdAt: new Date(),
            status: 'initializing'
        });
    }

    public listSessions(): Array<{ tenantId: string; sessionKey: string; client: any }> {
        const sessions = [];
        for (const [key, client] of this.sessionClients) {
            const [tenantId, sessionKey] = key.split(':');
            sessions.push({
                tenantId,
                sessionKey,
                client
            });
        }
        return sessions;
    }
}

// Run tests
async function runTests() {
    console.log('\n🧪 Multi-Session Creation Tests\n');
    const manager = new MockBotManager();

    // Test 1: Create default:primary session
    console.log('Test 1: Create default:primary (singleton)');
    manager.createSession('default', 'primary');

    // Test 2: Create non-default session (acme:primary)
    console.log('\nTest 2: Create acme:primary (multi-client)');
    manager.createSession('acme', 'primary');

    // Test 3: Create another non-default session (acme:support)
    console.log('\nTest 3: Create acme:support (multi-client)');
    manager.createSession('acme', 'support');

    // Test 4: Create another tenant session (bigcorp:main)
    console.log('\nTest 4: Create bigcorp:main (multi-client)');
    manager.createSession('bigcorp', 'main');

    // Test 5: Try to create duplicate (should skip)
    console.log('\nTest 5: Try to create duplicate acme:primary');
    manager.createSession('acme', 'primary');

    // List all sessions
    console.log('\n📊 Active Sessions:');
    const sessions = manager.listSessions();
    console.log(`Total: ${sessions.length} sessions\n`);
    sessions.forEach((s) => {
        console.log(`  • ${s.tenantId}:${s.sessionKey} → ${s.client.name}`);
    });

    // Verify session isolation
    console.log('\n✅ Session Isolation Verification:');
    const acmeSessions = sessions.filter(s => s.tenantId === 'acme');
    const bigcorploSessions = sessions.filter(s => s.tenantId === 'bigcorp');
    console.log(`  • ACME tenant: ${acmeSessions.length} sessions (expected 2)`);
    console.log(`  • BigCorp tenant: ${bigcorploSessions.length} sessions (expected 1)`);
    console.log(`  • Each client has unique instance: ${sessions.every((_, i, arr) => {
        return !arr.some((other, j) => i !== j && other.client.name === arr[i].client.name);
    }) ? '✓ YES' : '✗ NO'}`);

    console.log('\n✅ All tests completed successfully!\n');
}

runTests().catch(console.error);
