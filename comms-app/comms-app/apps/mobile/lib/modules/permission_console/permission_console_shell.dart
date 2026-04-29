import 'package:flutter/material.dart';

import '../../ui/colors.dart';
import 'models/permission_entity.dart';
import 'screens/permission_activity_screen.dart';
import 'screens/permission_analytics_screen.dart';
import 'screens/permission_entities_screen.dart';
import 'screens/permission_entity_detail_screen.dart';
import 'screens/permission_overview_screen.dart';
import 'services/behavior_trace_service.dart';
import 'services/mock_permission_repository.dart';

enum PermissionConsoleTab { overview, entities, analytics, activity }

class PermissionConsoleShell extends StatefulWidget {
  const PermissionConsoleShell({super.key});

  @override
  State<PermissionConsoleShell> createState() => _PermissionConsoleShellState();
}

class _PermissionConsoleShellState extends State<PermissionConsoleShell> {
  final MockPermissionRepository _repository = MockPermissionRepository();
  late final BehaviorTraceService _traceService = BehaviorTraceService(_repository);
  late final List<PermissionEntity> _entities = _repository.loadEntities();

  PermissionConsoleTab _tab = PermissionConsoleTab.overview;

  void _openEntity(PermissionEntity entity) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => PermissionEntityDetailScreen(
          entity: entity,
          record: _repository.loadRecord(entity.id),
          initialTrace: entity.trustState == PermissionTrustState.unknown ? null : _repository.loadLastTrace(entity.id),
          traceService: _traceService,
        ),
      ),
    );
  }

  Widget _body() {
    switch (_tab) {
      case PermissionConsoleTab.entities:
        return PermissionEntitiesScreen(entities: _entities, onEntitySelected: _openEntity);
      case PermissionConsoleTab.analytics:
        return PermissionAnalyticsScreen(entities: _entities);
      case PermissionConsoleTab.activity:
        return const PermissionActivityScreen();
      case PermissionConsoleTab.overview:
      default:
        return PermissionOverviewScreen(entities: _entities, onEntitySelected: _openEntity);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          color: SFColors.headerBlueDark,
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.15),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              children: PermissionConsoleTab.values.map((tab) {
                final selected = tab == _tab;
                return Expanded(
                  child: GestureDetector(
                    onTap: () => setState(() => _tab = tab),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      decoration: BoxDecoration(
                        color: selected ? Colors.white : Colors.transparent,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Center(
                        child: Text(
                          _label(tab),
                          style: TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 12,
                            color: selected ? SFColors.textPrimary : Colors.white,
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
        ),
        Expanded(child: _body()),
      ],
    );
  }

  String _label(PermissionConsoleTab tab) {
    switch (tab) {
      case PermissionConsoleTab.overview:
        return 'Overview';
      case PermissionConsoleTab.entities:
        return 'Entities';
      case PermissionConsoleTab.analytics:
        return 'Analytics';
      case PermissionConsoleTab.activity:
        return 'Activity';
    }
  }
}
