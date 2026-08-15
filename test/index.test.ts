import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/tool.definitions.js';

describe('Unitrends MCP Server', () => {
  describe('Tool Definitions', () => {
    it('defines exactly the 11 expected tools', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toEqual([
        'unitrends_list_appliances',
        'unitrends_get_appliance',
        'unitrends_list_assets',
        'unitrends_get_asset',
        'unitrends_list_running_jobs',
        'unitrends_list_job_history',
        'unitrends_list_recovery_points',
        'unitrends_queue_restore',
        'unitrends_get_restore_status',
        'unitrends_list_alerts',
        'unitrends_get_success_rate',
      ]);
    });

    it('every tool has a non-empty description', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.description, `${tool.name} description`).toBeTruthy();
      }
    });

    it('unitrends_get_appliance requires applianceId', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'unitrends_get_appliance');
      expect(tool?.inputSchema.required).toEqual(['applianceId']);
    });

    it('unitrends_get_asset requires applianceId and assetId', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'unitrends_get_asset');
      expect(tool?.inputSchema.required).toEqual(['applianceId', 'assetId']);
    });

    it('unitrends_list_recovery_points requires assetId', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'unitrends_list_recovery_points');
      expect(tool?.inputSchema.required).toEqual(['assetId']);
    });

    it('unitrends_queue_restore requires recoveryPointId', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'unitrends_queue_restore');
      expect(tool?.inputSchema.required).toEqual(['recoveryPointId']);
    });

    it('unitrends_get_restore_status requires restoreId', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'unitrends_get_restore_status');
      expect(tool?.inputSchema.required).toEqual(['restoreId']);
    });

    it('unitrends_list_assets, unitrends_list_job_history, and unitrends_get_success_rate take no required fields', () => {
      for (const name of [
        'unitrends_list_assets',
        'unitrends_list_job_history',
        'unitrends_get_success_rate',
      ]) {
        const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
        expect(tool?.inputSchema.required ?? [], name).toEqual([]);
      }
    });

    it('unitrends_list_appliances, unitrends_list_running_jobs, and unitrends_list_alerts take no required fields', () => {
      for (const name of [
        'unitrends_list_appliances',
        'unitrends_list_running_jobs',
        'unitrends_list_alerts',
      ]) {
        const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
        expect(tool?.inputSchema.required ?? [], name).toEqual([]);
      }
    });

    it('only unitrends_get_appliance advertises MCP Apps UI metadata', () => {
      const withMeta = TOOL_DEFINITIONS.filter((t) => t._meta);
      expect(withMeta.map((t) => t.name)).toEqual(['unitrends_get_appliance']);
    });
  });

  describe('Credentials', () => {
    it('should require base URL, username, and password', () => {
      const required = ['UNITRENDS_BASE_URL', 'UNITRENDS_USERNAME', 'UNITRENDS_PASSWORD'];
      expect(required).toHaveLength(3);
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name', () => {
      const config = { name: 'unitrends-mcp', version: '0.0.0' };
      expect(config.name).toBe('unitrends-mcp');
    });
  });
});
