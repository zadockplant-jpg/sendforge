import 'package:flutter/material.dart';
import 'group_avatar_catalog.dart';
import 'group_avatar_atlas.dart';

class AvatarPickerModal extends StatelessWidget {
  final String? selected;
  final ValueChanged<String> onSelected;

  const AvatarPickerModal({
    super.key,
    required this.selected,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Dialog(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: SizedBox(
          width: 420,
          height: 420,
          child: GridView.count(
            crossAxisCount: 6,
            crossAxisSpacing: 8,
            mainAxisSpacing: 8,
            children: groupAvatarCatalog.map((key) {
              final isSelected = key == selected;
              return GestureDetector(
                onTap: () {
                  onSelected(key);
                  Navigator.pop(context);
                },
                child: Container(
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: isSelected ? Colors.blue : Colors.transparent,
                      width: 2,
                    ),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: GroupAvatarAtlas(
                    avatarKey: key,
                    size: 48,
                  ),
                ),
              );
            }).toList(),
          ),
        ),
      ),
    );
  }
}