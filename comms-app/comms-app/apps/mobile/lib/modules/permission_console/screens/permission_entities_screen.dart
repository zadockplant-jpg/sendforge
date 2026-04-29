import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_entity.dart';
import '../widgets/permission_entity_row.dart';

class PermissionEntitiesScreen extends StatefulWidget {
  final List<PermissionEntity> entities;
  final ValueChanged<PermissionEntity> onEntitySelected;

  const PermissionEntitiesScreen({
    super.key,
    required this.entities,
    required this.onEntitySelected,
  });

  @override
  State<PermissionEntitiesScreen> createState() => _PermissionEntitiesScreenState();
}

class _PermissionEntitiesScreenState extends State<PermissionEntitiesScreen> {
  String _filter = 'All';
  String _query = '';

  List<String> get _filters => const [
        'All',
        'Verified',
        'Time-Limited',
        'Expiring',
        'Flagged',
        'High Access',
        'Individuals',
        'Businesses',
      ];

  List<PermissionEntity> get _visibleEntities {
    return widget.entities.where((entity) {
      final matchesQuery = _query.trim().isEmpty ||
          entity.name.toLowerCase().contains(_query.toLowerCase()) ||
          entity.typeLabel.toLowerCase().contains(_query.toLowerCase()) ||
          entity.dataSummary.join(' ').toLowerCase().contains(_query.toLowerCase());

      if (!matchesQuery) return false;

      switch (_filter) {
        case 'Verified':
          return entity.verificationState == PermissionVerificationState.verified;
        case 'Time-Limited':
          return entity.timeRemainingPercent > 0 && entity.timeRemainingPercent < 1;
        case 'Expiring':
          return entity.timeRemainingPercent > 0 && entity.timeRemainingPercent < 0.4;
        case 'Flagged':
          return entity.trustState == PermissionTrustState.flagged || entity.trustState == PermissionTrustState.revoked;
        case 'High Access':
          return entity.dataSummary.length >= 3;
        case 'Individuals':
          return entity.type == PermissionEntityType.individual;
        case 'Businesses':
          return entity.type != PermissionEntityType.individual;
        case 'All':
        default:
          return true;
      }
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
          child: TextField(
            onChanged: (value) => setState(() => _query = value),
            decoration: InputDecoration(
              hintText: 'Search entities, data types, company types...',
              prefixIcon: const Icon(Icons.search),
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: SFColors.cardBorder),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: const BorderSide(color: SFColors.cardBorder),
              ),
            ),
          ),
        ),
        SizedBox(
          height: 42,
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            scrollDirection: Axis.horizontal,
            itemCount: _filters.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final filter = _filters[index];
              final selected = filter == _filter;
              return ChoiceChip(
                label: Text(filter),
                selected: selected,
                onSelected: (_) => setState(() => _filter = filter),
                selectedColor: SFColors.primaryBlue.withOpacity(0.12),
                labelStyle: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: selected ? SFColors.primaryBlue : SFColors.textPrimary,
                ),
                side: const BorderSide(color: SFColors.cardBorder),
              );
            },
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(14),
            itemCount: _visibleEntities.length,
            itemBuilder: (context, index) {
              final entity = _visibleEntities[index];
              return PermissionEntityRow(entity: entity, onTap: () => widget.onEntitySelected(entity));
            },
          ),
        ),
      ],
    );
  }
}
