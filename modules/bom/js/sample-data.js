"use strict";
/* 内置示例供应链：智能网关 G200（v7）。
   示例公司与关系均为虚构数据；市场准入记录初始为空，待人工添加证据。
   公司合规使用四色状态；legacyScore 仅为旧评分归档，不参与新界面判断。
   历史 risks 分数仅为旧备份兼容数据，新界面不会读取或转换为准入结论。 */
const SAMPLE_BOM_STATE = {
  "format": "bom-flow",
  "version": 7,
  "counter": 89,
  "activeDiagramId": "d1",
  "diagrams": [
    {
      "id": "d1",
      "rootNodeId": "n3",
      "risks": {
        "c44": {
          "score": 68,
          "categories": [
            "supply",
            "quality",
            "transparency",
            "geo"
          ],
          "note": "主控 SoC 与表面处理均为单一来源；深圳芯联 RoHS 复测未完成、苏州绿环排污许可 2026-12 到期；新竹基带受出口管制与第三地转运影响。建议 2027 Q1 前完成第二来源导入与整改复核。",
          "updatedAt": 1794920499274
        }
      },
      "assessments": {}
    }
  ],
  "nodes": {
    "n3": {
      "id": "n3",
      "diagramId": "d1",
      "materialId": "m2",
      "parentId": null,
      "companyIds": [
        "c44"
      ],
      "qty": 1,
      "unit": "",
      "x": 52,
      "y": 1156
    },
    "n5": {
      "id": "n5",
      "diagramId": "d1",
      "materialId": "m4",
      "parentId": "n3",
      "companyIds": [
        "c45"
      ],
      "qty": 1,
      "unit": "件",
      "x": 370,
      "y": 232
    },
    "n7": {
      "id": "n7",
      "diagramId": "d1",
      "materialId": "m6",
      "parentId": "n3",
      "companyIds": [
        "c46",
        "c47"
      ],
      "qty": 1,
      "unit": "件",
      "x": 370,
      "y": 652
    },
    "n9": {
      "id": "n9",
      "diagramId": "d1",
      "materialId": "m8",
      "parentId": "n3",
      "companyIds": [
        "c48"
      ],
      "qty": 1,
      "unit": "件",
      "x": 370,
      "y": 988
    },
    "n11": {
      "id": "n11",
      "diagramId": "d1",
      "materialId": "m10",
      "parentId": "n3",
      "companyIds": [
        "c49"
      ],
      "qty": 1,
      "unit": "套",
      "x": 370,
      "y": 1324
    },
    "n13": {
      "id": "n13",
      "diagramId": "d1",
      "materialId": "m12",
      "parentId": "n3",
      "companyIds": [
        "c50"
      ],
      "qty": 1,
      "unit": "套",
      "x": 370,
      "y": 1660
    },
    "n15": {
      "id": "n15",
      "diagramId": "d1",
      "materialId": "m14",
      "parentId": "n3",
      "companyIds": [],
      "qty": 1,
      "unit": "套",
      "x": 370,
      "y": 1912
    },
    "n17": {
      "id": "n17",
      "diagramId": "d1",
      "materialId": "m16",
      "parentId": "n3",
      "companyIds": [
        "c51"
      ],
      "qty": 1,
      "unit": "套",
      "x": 370,
      "y": 2080
    },
    "n19": {
      "id": "n19",
      "diagramId": "d1",
      "materialId": "m18",
      "parentId": "n5",
      "companyIds": [
        "c52"
      ],
      "qty": 1,
      "unit": "颗",
      "x": 688,
      "y": 64
    },
    "n21": {
      "id": "n21",
      "diagramId": "d1",
      "materialId": "m20",
      "parentId": "n5",
      "companyIds": [
        "c53"
      ],
      "qty": 2,
      "unit": "颗",
      "x": 688,
      "y": 232
    },
    "n23": {
      "id": "n23",
      "diagramId": "d1",
      "materialId": "m22",
      "parentId": "n5",
      "companyIds": [
        "c54"
      ],
      "qty": 1,
      "unit": "片",
      "x": 688,
      "y": 400
    },
    "n25": {
      "id": "n25",
      "diagramId": "d1",
      "materialId": "m24",
      "parentId": "n7",
      "companyIds": [
        "c55"
      ],
      "qty": 1,
      "unit": "个",
      "x": 688,
      "y": 568
    },
    "n27": {
      "id": "n27",
      "diagramId": "d1",
      "materialId": "m26",
      "parentId": "n7",
      "companyIds": [
        "c56"
      ],
      "qty": 4,
      "unit": "颗",
      "x": 688,
      "y": 736
    },
    "n29": {
      "id": "n29",
      "diagramId": "d1",
      "materialId": "m28",
      "parentId": "n9",
      "companyIds": [
        "c57"
      ],
      "qty": 1,
      "unit": "颗",
      "x": 688,
      "y": 904
    },
    "n31": {
      "id": "n31",
      "diagramId": "d1",
      "materialId": "m30",
      "parentId": "n9",
      "companyIds": [
        "c58"
      ],
      "qty": 1,
      "unit": "套",
      "x": 688,
      "y": 1072
    },
    "n33": {
      "id": "n33",
      "diagramId": "d1",
      "materialId": "m32",
      "parentId": "n11",
      "companyIds": [
        "c59"
      ],
      "qty": 1,
      "unit": "件",
      "x": 688,
      "y": 1240
    },
    "n35": {
      "id": "n35",
      "diagramId": "d1",
      "materialId": "m34",
      "parentId": "n11",
      "companyIds": [
        "c60"
      ],
      "qty": 1,
      "unit": "套",
      "x": 688,
      "y": 1408
    },
    "n37": {
      "id": "n37",
      "diagramId": "d1",
      "materialId": "m36",
      "parentId": "n13",
      "companyIds": [
        "c61"
      ],
      "qty": 4,
      "unit": "个",
      "x": 688,
      "y": 1576
    },
    "n39": {
      "id": "n39",
      "diagramId": "d1",
      "materialId": "m38",
      "parentId": "n13",
      "companyIds": [
        "c62"
      ],
      "qty": 8,
      "unit": "米",
      "x": 688,
      "y": 1744
    },
    "n41": {
      "id": "n41",
      "diagramId": "d1",
      "materialId": "m40",
      "parentId": "n29",
      "companyIds": [
        "c63"
      ],
      "qty": 1,
      "unit": "片",
      "x": 1006,
      "y": 904
    },
    "n43": {
      "id": "n43",
      "diagramId": "d1",
      "materialId": "m42",
      "parentId": "n41",
      "companyIds": [
        "c64"
      ],
      "qty": 1,
      "unit": "片",
      "x": 1324,
      "y": 904
    }
  },
  "materials": {
    "m2": {
      "id": "m2",
      "name": "智能网关 G200",
      "code": "GW-G200",
      "note": "工业级边缘网关：双千兆网口、5G Sub-6、宽温 -40~75°C，支持 Modbus/OPC UA。"
    },
    "m4": {
      "id": "m4",
      "name": "主控模组",
      "code": "MOD-MCU-01",
      "note": "四核 ARM SoC + 2GB DDR4，含 6 层 PCB 与电源管理。"
    },
    "m6": {
      "id": "m6",
      "name": "电源模组",
      "code": "MOD-PWR-11",
      "note": "宽压 12–48V 输入，双路隔离输出，支持冗余供电。"
    },
    "m8": {
      "id": "m8",
      "name": "通信模组",
      "code": "MOD-5G-21",
      "note": "5G Sub-6 + 千兆以太网，支持双 SIM。"
    },
    "m10": {
      "id": "m10",
      "name": "结构件",
      "code": "ME-AL-31",
      "note": "铝合金压铸外壳，IP65 防护，阳极氧化表面。"
    },
    "m12": {
      "id": "m12",
      "name": "线束与连接器",
      "code": "WH-CON-41",
      "note": "M12 A 编码连接器与内部线束。"
    },
    "m14": {
      "id": "m14",
      "name": "包装材料",
      "code": "PKG-51",
      "note": "防静电内衬、干燥剂与出口五层瓦楞纸箱。"
    },
    "m16": {
      "id": "m16",
      "name": "散热组件",
      "code": "TH-61",
      "note": "导热硅脂与铝挤散热片，新导入料号。"
    },
    "m18": {
      "id": "m18",
      "name": "SoC 芯片",
      "code": "IC-SOC-8C",
      "note": "8nm 四核 A55，工业级 -40~85°C，AEC-Q100 报告齐全。"
    },
    "m20": {
      "id": "m20",
      "name": "DDR4 内存",
      "code": "IC-DDR4-2G",
      "note": "2Gb DDR4-2666，原厂授权代理供货。"
    },
    "m22": {
      "id": "m22",
      "name": "PCB 板",
      "code": "PCB-6L-01",
      "note": "6 层沉金板，阻抗控制，UL 认证。"
    },
    "m24": {
      "id": "m24",
      "name": "变压器",
      "code": "TR-EF25",
      "note": "EF25 高频变压器，UL 绝缘系统认证。"
    },
    "m26": {
      "id": "m26",
      "name": "功率器件",
      "code": "MOS-650V",
      "note": "650V 超结 MOSFET，车规产线。"
    },
    "m28": {
      "id": "m28",
      "name": "基带芯片",
      "code": "IC-BB-5G",
      "note": "5G NR Sub-6 基带，出口管制最终用户声明待补。"
    },
    "m30": {
      "id": "m30",
      "name": "射频前端",
      "code": "RF-FE-01",
      "note": "n78/n41 射频前端模组，晶圆代工单一来源。"
    },
    "m32": {
      "id": "m32",
      "name": "铝合金压铸",
      "code": "AL-DC-01",
      "note": "ADC12 压铸，喷粉前处理。"
    },
    "m34": {
      "id": "m34",
      "name": "表面处理",
      "code": "SURF-AN",
      "note": "阳极氧化 + 导电氧化，涉及排污许可。"
    },
    "m36": {
      "id": "m36",
      "name": "连接器",
      "code": "CON-M12",
      "note": "M12 A 编码 8 芯连接器。"
    },
    "m38": {
      "id": "m38",
      "name": "铜线",
      "code": "CU-18AWG",
      "note": "18AWG 镀锡铜线，阻燃 PVC 护套。"
    },
    "m40": {
      "id": "m40",
      "name": "封装基板",
      "code": "SUB-BT-01",
      "note": "BT 树脂 8 层封装基板。"
    },
    "m42": {
      "id": "m42",
      "name": "覆铜板",
      "code": "CCL-FR4",
      "note": "FR-4 无卤覆铜板，Tg170。"
    }
  },
  "companies": {
    "c44": {
      "id": "c44",
      "name": "杭州智联科技有限公司",
      "location": "杭州市滨江区江陵路 88 号",
      "contact": "王敏 · 138-5710-2233 · wangmin@zhilian-iot.example",
      "note": "最终组装、整机测试与出货；工业物联网网关主机制造商。",
      "extraFields": {
        "统一社会信用代码": "91330108MA2B7K8X1Q",
        "IATF 16949": "有效至 2027-09",
        "年产能": "12 万台"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 93,
        "reason": "IATF 16949 与 ISO 14001 有效；2026 年客户审核通过，无重大不符合项。",
        "updatedAt": 1794920499273
      }
    },
    "c45": {
      "id": "c45",
      "name": "深圳芯联电子有限公司",
      "location": "深圳市宝安区新桥街道创新路 6 号",
      "contact": "陈立 · 139-2288-1102 · chenli@xinlian-elec.example",
      "note": "主控模组设计与封测；RoHS 复测进行中。",
      "extraFields": {
        "统一社会信用代码": "91440300MA5F2Q7L3D",
        "ISO 9001": "有效至 2027-08",
        "主要产品": "ARM 网关主控模组"
      },
      "compliance": {
        "status": "severe",
        "legacyScore": 58,
        "reason": "RoHS 报告 2026-09 到期未续；2026 Q3 制程审核 2 项不符合项未闭环。",
        "updatedAt": 1794920499273
      }
    },
    "c46": {
      "id": "c46",
      "name": "东莞恒力电源科技有限公司",
      "location": "东莞市松山湖园区工业北路 12 号",
      "contact": "李强 · 137-1234-8890 · liqiang@hengli-power.example",
      "note": "工业电源模组主供应商；双基地供货。",
      "extraFields": {
        "统一社会信用代码": "91441900MA4W9T2N8K",
        "UL 62368": "有效至 2027-06",
        "年产能": "80 万件"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 86,
        "reason": "ISO 9001 / UL 62368 有效，2026 年度审核通过。",
        "updatedAt": 1794920499273
      }
    },
    "c47": {
      "id": "c47",
      "name": "佛山创能电源有限公司",
      "location": "佛山市顺德区容桂街道科技路 9 号",
      "contact": "周颖 · 136-9087-2210 · zhouying@chuangneng.example",
      "note": "电源模组第二来源，承接 30% 左右份额。",
      "extraFields": {
        "统一社会信用代码": "91440606MA51C8P4X2",
        "UL 62368": "2027-01 到期",
        "年产能": "40 万件"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 80,
        "reason": "ISO 9001 有效；UL 62368 证书 2027-01 到期，需提前安排复审。",
        "updatedAt": 1794920499273
      }
    },
    "c48": {
      "id": "c48",
      "name": "上海联讯无线科技有限公司",
      "location": "上海市浦东新区张江高科技园区科苑路 399 号",
      "contact": "赵晨 · 135-0192-7788 · zhaochen@lianxun-wireless.example",
      "note": "5G 通信模组设计；出口管制合规审查中。",
      "extraFields": {
        "统一社会信用代码": "91310115MA1K4R6T9W",
        "ISO 9001": "有效至 2028-03",
        "出口管制": "最终用户声明待更新"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 82,
        "reason": "ISO 9001 有效；出口管制最终用户声明待更新。",
        "updatedAt": 1794920499273
      }
    },
    "c49": {
      "id": "c49",
      "name": "苏州精工结构件有限公司",
      "location": "苏州市吴中区胥口镇工业园 18 号",
      "contact": "孙浩 · 139-6210-3344 · sunhao@jinggong-struct.example",
      "note": "铝合金压铸与表面处理总成；客户年度审核 A 级。",
      "extraFields": {
        "统一社会信用代码": "91320506MA1W8Y3C5F",
        "ISO 14001": "有效至 2027-12",
        "客户审核": "A 级"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 91,
        "reason": "ISO 9001 / ISO 14001 有效，客户年度审核 A 级。",
        "updatedAt": 1794920499273
      }
    },
    "c50": {
      "id": "c50",
      "name": "昆山联捷电子有限公司",
      "location": "昆山市开发区前进东路 66 号",
      "contact": "吴倩 · 138-1456-9900 · wuqian@lianjie-elec.example",
      "note": "M12 连接器与线束加工；UL 认证部分料号待覆盖。",
      "extraFields": {
        "统一社会信用代码": "91320583MA1N6D4H7J",
        "UL 认证": "2 个新料号未覆盖",
        "IATF 16949": "有效至 2027-05"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 69,
        "reason": "UL 认证未覆盖 2 个新料号；来料检验记录缺失 2 批。",
        "updatedAt": 1794920499273
      }
    },
    "c51": {
      "id": "c51",
      "name": "深圳散热科技有限公司",
      "location": "深圳市龙华区观澜街道大和路 28 号",
      "contact": "何军 · 137-6677-1188 · hejun@sanre-tech.example",
      "note": "导热与散热组件；新导入供应商，处于小批量试产。",
      "extraFields": {
        "统一社会信用代码": "91440300MA5G7X2B6L",
        "ISO 9001": "有效至 2028-01",
        "准入状态": "小批量试产"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 76,
        "reason": "ISO 9001 有效；导热硅脂 RoHS 报告待更新，处于小批量试产。",
        "updatedAt": 1794920499273
      }
    },
    "c52": {
      "id": "c52",
      "name": "上海华晶集成电路有限公司",
      "location": "上海市浦东新区临港新片区云水路 100 号",
      "contact": "徐磊 · 136-0188-5522 · xulei@huajing-ic.example",
      "note": "SoC 设计与晶圆制造；临港 12 英寸产线。",
      "extraFields": {
        "统一社会信用代码": "91310115MA1H9W6R2C",
        "ISO 9001": "有效至 2028-06",
        "晶圆厂": "临港 12 英寸"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 89,
        "reason": "ISO 9001 有效；车规级 AEC-Q100 报告齐全。",
        "updatedAt": 1794920499273
      }
    },
    "c53": {
      "id": "c53",
      "name": "深圳易存半导体有限公司",
      "location": "深圳市坪山区锦绣东路 12 号",
      "contact": "黄莉 · 135-1066-7788 · huangli@yicun-semi.example",
      "note": "DDR4 存储颗粒代理；原厂授权书 2027-03 到期。",
      "extraFields": {
        "统一社会信用代码": "91440300MA5D3S8K9P",
        "品牌授权": "原厂授权代理",
        "授权有效期": "2027-03"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 82,
        "reason": "ISO 9001 有效；原厂授权书 2027-03 到期。",
        "updatedAt": 1794920499273
      }
    },
    "c54": {
      "id": "c54",
      "name": "昆山鼎鑫电路板有限公司",
      "location": "昆山市千灯镇电路板产业园 5 号",
      "contact": "张伟 · 139-6266-3344 · zhangwei@dingxin-pcb.example",
      "note": "6 层 PCB 供应商；ISO 14001 复审中。",
      "extraFields": {
        "统一社会信用代码": "91320583MA1P4C7N2T",
        "ISO 14001": "复审中",
        "年产能": "30 万平米"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 72,
        "reason": "ISO 14001 复审中；废水处理台账不完整。",
        "updatedAt": 1794920499273
      }
    },
    "c55": {
      "id": "c55",
      "name": "东莞磁通电子有限公司",
      "location": "东莞市石碣镇科技中路 8 号",
      "contact": "刘洋 · 137-2288-9911 · liuyang@citong-elec.example",
      "note": "高频变压器与磁件；同时供应两家电源厂。",
      "extraFields": {
        "统一社会信用代码": "91441900MA4L7H3D5B",
        "ISO 9001": "有效至 2027-09",
        "年产能": "120 万只"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 85,
        "reason": "ISO 9001 有效；UL 绝缘系统认证有效。",
        "updatedAt": 1794920499273
      }
    },
    "c56": {
      "id": "c56",
      "name": "无锡芯源功率半导体有限公司",
      "location": "无锡市新吴区菱湖大道 200 号",
      "contact": "陆涛 · 138-6188-2200 · lutao@xinyuan-power.example",
      "note": "超结 MOSFET；车规产线产能满载。",
      "extraFields": {
        "统一社会信用代码": "91320214MA1N8R5W6X",
        "IATF 16949": "2027-02 到期",
        "PPAP": "待更新"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 68,
        "reason": "IATF 16949 证书 2027-02 到期；PPAP 文件未更新，产能满载。",
        "updatedAt": 1794920499273
      }
    },
    "c57": {
      "id": "c57",
      "name": "新竹联芯通信股份有限公司",
      "location": "新竹科学园区创新二路 7 号",
      "contact": "林志明 · +886-3-578-2211 · lin@hsinchu-unichip.example",
      "note": "5G 基带芯片；出口管制最终用户声明待补。",
      "extraFields": {
        "统一社会信用代码": "TW-28123456",
        "出口管制": "最终用户声明待补",
        "物流": "经第三地转运"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 73,
        "reason": "出口管制最终用户声明待补；经第三地转运，交期波动约 2 周。",
        "updatedAt": 1794920499273
      }
    },
    "c58": {
      "id": "c58",
      "name": "深圳射频微电子有限公司",
      "location": "深圳市南山区科技园北区朗山路 15 号",
      "contact": "郑凯 · 135-8899-3344 · zhengkai@rf-micro.example",
      "note": "射频前端模组；晶圆代工单一来源。",
      "extraFields": {
        "统一社会信用代码": "91440300MA5F8N2Q7R",
        "ISO 9001": "有效至 2028-02",
        "代工来源": "单一代工厂"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 74,
        "reason": "ISO 9001 有效；晶圆代工单一来源，无备份产能。",
        "updatedAt": 1794920499273
      }
    },
    "c59": {
      "id": "c59",
      "name": "宁波宏达精密压铸有限公司",
      "location": "宁波市北仑区大碶街道工业区 22 号",
      "contact": "王海 · 137-5740-1188 · wanghai@hongda-dc.example",
      "note": "铝合金压铸；ADC12 材料成分报告齐全。",
      "extraFields": {
        "统一社会信用代码": "91330206MA2A7K3L4M",
        "ISO 9001": "有效至 2027-10",
        "年产能": "50 万件"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 84,
        "reason": "ISO 9001 有效；材料成分报告齐全。",
        "updatedAt": 1794920499273
      }
    },
    "c60": {
      "id": "c60",
      "name": "苏州绿环表面处理有限公司",
      "location": "苏州市吴江区汾湖高新区 9 号",
      "contact": "沈明 · 139-6255-7788 · shenming@lvhuan-surface.example",
      "note": "阳极氧化与导电氧化；排污许可证 2026-12 到期。",
      "extraFields": {
        "统一社会信用代码": "91320509MA1W6Y8C3D",
        "排污许可证": "2026-12 到期",
        "在线监测": "缺失"
      },
      "compliance": {
        "status": "severe",
        "legacyScore": 47,
        "reason": "排污许可证 2026-12 到期，换证材料未提交；重金属在线监测缺失，EHS 审核不通过。",
        "updatedAt": 1794920499273
      }
    },
    "c61": {
      "id": "c61",
      "name": "温州瑞联连接器有限公司",
      "location": "温州市乐清市柳市镇新光工业区 3 号",
      "contact": "陈晓 · 136-5777-2211 · chenxiao@ruilian-conn.example",
      "note": "M12 连接器；UL 认证覆盖主要料号。",
      "extraFields": {
        "统一社会信用代码": "91330382MA2C8L5N7P",
        "UL 认证": "主要料号覆盖",
        "ISO 9001": "有效至 2027-07"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 77,
        "reason": "ISO 9001 有效；UL 认证覆盖主要料号。",
        "updatedAt": 1794920499273
      }
    },
    "c62": {
      "id": "c62",
      "name": "江苏江铜线缆有限公司",
      "location": "无锡市宜兴市官林镇工业集中区 16 号",
      "contact": "周平 · 138-6155-9900 · zhouping@jiangtong-cable.example",
      "note": "镀锡铜线与线缆；新供应商，准入审核尚未完成。",
      "extraFields": {
        "统一社会信用代码": "91320282MA1X9C4R6T",
        "准入状态": "待审核",
        "ISO 9001": "待补充"
      },
      "compliance": {
        "status": "unverified",
        "legacyScore": null,
        "reason": "",
        "updatedAt": null
      }
    },
    "c63": {
      "id": "c63",
      "name": "深圳基板科技股份有限公司",
      "location": "深圳市龙岗区宝龙工业区 11 号",
      "contact": "罗成 · 135-1088-6677 · luocheng@jiban-tech.example",
      "note": "BT 树脂封装基板；8 层，供应 5G 基带封装。",
      "extraFields": {
        "统一社会信用代码": "91440300MA5E2T9H4J",
        "ISO 9001": "有效至 2028-04",
        "年产能": "20 万平米"
      },
      "compliance": {
        "status": "qualified",
        "legacyScore": 81,
        "reason": "ISO 9001 有效；BT 材料 RoHS 报告齐全。",
        "updatedAt": 1794920499273
      }
    },
    "c64": {
      "id": "c64",
      "name": "广东覆铜板材料有限公司",
      "location": "东莞市松山湖园区南山路 6 号",
      "contact": "梁伟 · 137-2299-6600 · liangwei@futong-ccl.example",
      "note": "FR-4 无卤覆铜板；铜价波动导致报价有效期缩短。",
      "extraFields": {
        "统一社会信用代码": "91441900MA4P8K2N5Q",
        "无卤认证": "2027-01 到期",
        "ISO 14001": "有效至 2027-11"
      },
      "compliance": {
        "status": "risk",
        "legacyScore": 70,
        "reason": "FR-4 无卤认证 2027-01 到期；铜价波动导致报价有效期缩短至 30 天。",
        "updatedAt": 1794920499273
      }
    }
  },
  "factories": {
    "f65": {
      "id": "f65",
      "companyId": "c44",
      "name": "杭州总装一厂",
      "location": "杭州市滨江区江陵路 88 号",
      "contact": "王敏 · 138-5710-2233",
      "note": "整机总装、老化与出货检验。",
      "extraFields": {
        "产线": "3 条",
        "年产能": "8 万台"
      }
    },
    "f66": {
      "id": "f66",
      "companyId": "c44",
      "name": "杭州总装二厂",
      "location": "杭州市萧山区鸿达路 9 号",
      "contact": "李娜 · 137-5711-8899",
      "note": "车规版专线与返修中心。",
      "extraFields": {
        "产线": "1 条",
        "年产能": "4 万台"
      }
    },
    "f67": {
      "id": "f67",
      "companyId": "c45",
      "name": "深圳宝安封测厂",
      "location": "深圳市宝安区新桥创新路 6 号",
      "contact": "陈立 · 139-2288-1102",
      "note": "主控模组 SMT 与功能测试。",
      "extraFields": {
        "SMT 线": "6 条"
      }
    },
    "f68": {
      "id": "f68",
      "companyId": "c45",
      "name": "东莞松山湖封测厂",
      "location": "东莞市松山湖工业北路 3 号",
      "contact": "刘峰 · 137-2288-7766",
      "note": "DDR 与 PCB 贴装备份产线。",
      "extraFields": {
        "SMT 线": "2 条"
      }
    },
    "f69": {
      "id": "f69",
      "companyId": "c46",
      "name": "东莞松山湖电源厂",
      "location": "东莞市松山湖工业北路 12 号",
      "contact": "李强 · 137-1234-8890",
      "note": "电源模组主产线。",
      "extraFields": {
        "年产能": "60 万件"
      }
    },
    "f70": {
      "id": "f70",
      "companyId": "c46",
      "name": "东莞大朗电源厂",
      "location": "东莞市大朗镇金朗路 8 号",
      "contact": "张敏 · 136-1234-5566",
      "note": "功率器件与变压器装配。",
      "extraFields": {
        "年产能": "20 万件"
      }
    },
    "f71": {
      "id": "f71",
      "companyId": "c47",
      "name": "佛山顺德电源厂",
      "location": "佛山市顺德区容桂科技路 9 号",
      "contact": "周颖 · 136-9087-2210",
      "note": "电源模组第二来源产线。",
      "extraFields": {
        "年产能": "40 万件"
      }
    },
    "f72": {
      "id": "f72",
      "companyId": "c48",
      "name": "上海张江无线厂",
      "location": "上海市浦东新区张江科苑路 399 号",
      "contact": "赵晨 · 135-0192-7788",
      "note": "5G 模组主产线。",
      "extraFields": {
        "年产能": "30 万件"
      }
    },
    "f73": {
      "id": "f73",
      "companyId": "c48",
      "name": "苏州工业园无线厂",
      "location": "苏州市工业园区星龙街 18 号",
      "contact": "钱伟 · 139-6211-3322",
      "note": "射频与天线装配备份线。",
      "extraFields": {
        "年产能": "12 万件"
      }
    },
    "f74": {
      "id": "f74",
      "companyId": "c49",
      "name": "苏州吴中结构件厂",
      "location": "苏州市吴中区胥口工业园 18 号",
      "contact": "孙浩 · 139-6210-3344",
      "note": "压铸、机加与表面处理总成。",
      "extraFields": {
        "压铸机": "8 台"
      }
    },
    "f75": {
      "id": "f75",
      "companyId": "c50",
      "name": "昆山开发区线束厂",
      "location": "昆山市开发区前进东路 66 号",
      "contact": "吴倩 · 138-1456-9900",
      "note": "连接器装配与线束加工。",
      "extraFields": {
        "产线": "4 条"
      }
    },
    "f76": {
      "id": "f76",
      "companyId": "c51",
      "name": "深圳龙华散热厂",
      "location": "深圳市龙华区观澜大和路 28 号",
      "contact": "何军 · 137-6677-1188",
      "note": "导热硅脂涂布与散热片加工。",
      "extraFields": {
        "状态": "试产"
      }
    },
    "f77": {
      "id": "f77",
      "companyId": "c52",
      "name": "上海临港晶圆厂",
      "location": "上海市浦东新区临港云水路 100 号",
      "contact": "徐磊 · 136-0188-5522",
      "note": "8nm 晶圆制造。",
      "extraFields": {
        "工艺": "8nm"
      }
    },
    "f78": {
      "id": "f78",
      "companyId": "c53",
      "name": "深圳坪山存储厂",
      "location": "深圳市坪山区锦绣东路 12 号",
      "contact": "黄莉 · 135-1066-7788",
      "note": "存储颗粒分选与编带。",
      "extraFields": {
        "产线": "3 条"
      }
    },
    "f79": {
      "id": "f79",
      "companyId": "c54",
      "name": "昆山千灯 PCB 厂",
      "location": "昆山市千灯镇电路板产业园 5 号",
      "contact": "张伟 · 139-6266-3344",
      "note": "6 层 PCB 生产。",
      "extraFields": {
        "月产能": "2.5 万平米"
      }
    },
    "f80": {
      "id": "f80",
      "companyId": "c55",
      "name": "东莞石碣磁件厂",
      "location": "东莞市石碣镇科技中路 8 号",
      "contact": "刘洋 · 137-2288-9911",
      "note": "高频变压器与磁环。",
      "extraFields": {
        "年产能": "120 万只"
      }
    },
    "f81": {
      "id": "f81",
      "companyId": "c56",
      "name": "无锡新吴功率器件厂",
      "location": "无锡市新吴区菱湖大道 200 号",
      "contact": "陆涛 · 138-6188-2200",
      "note": "超结 MOSFET 车规产线。",
      "extraFields": {
        "产线": "2 条"
      }
    },
    "f82": {
      "id": "f82",
      "companyId": "c57",
      "name": "新竹科学园晶圆厂",
      "location": "新竹科学园区创新二路 7 号",
      "contact": "林志明 · +886-3-578-2211",
      "note": "5G 基带晶圆制造。",
      "extraFields": {
        "工艺": "12nm"
      }
    },
    "f83": {
      "id": "f83",
      "companyId": "c58",
      "name": "深圳南山射频厂",
      "location": "深圳市南山区朗山路 15 号",
      "contact": "郑凯 · 135-8899-3344",
      "note": "射频前端模组封装测试。",
      "extraFields": {
        "产线": "2 条"
      }
    },
    "f84": {
      "id": "f84",
      "companyId": "c59",
      "name": "宁波北仑压铸厂",
      "location": "宁波市北仑区大碶工业区 22 号",
      "contact": "王海 · 137-5740-1188",
      "note": "ADC12 铝合金压铸。",
      "extraFields": {
        "压铸机": "10 台"
      }
    },
    "f85": {
      "id": "f85",
      "companyId": "c60",
      "name": "苏州吴江表面处理厂",
      "location": "苏州市吴江区汾湖高新区 9 号",
      "contact": "沈明 · 139-6255-7788",
      "note": "阳极氧化与导电氧化。",
      "extraFields": {
        "产线": "3 条"
      }
    },
    "f86": {
      "id": "f86",
      "companyId": "c61",
      "name": "温州乐清连接器厂",
      "location": "温州市乐清市柳市新光工业区 3 号",
      "contact": "陈晓 · 136-5777-2211",
      "note": "M12 连接器生产。",
      "extraFields": {
        "产线": "5 条"
      }
    },
    "f87": {
      "id": "f87",
      "companyId": "c62",
      "name": "无锡宜兴线缆厂",
      "location": "无锡市宜兴市官林工业集中区 16 号",
      "contact": "周平 · 138-6155-9900",
      "note": "镀锡铜线与护套线生产。",
      "extraFields": {
        "产线": "2 条"
      }
    },
    "f88": {
      "id": "f88",
      "companyId": "c63",
      "name": "深圳龙岗基板厂",
      "location": "深圳市龙岗区宝龙工业区 11 号",
      "contact": "罗成 · 135-1088-6677",
      "note": "BT 封装基板生产。",
      "extraFields": {
        "月产能": "1.6 万平米"
      }
    },
    "f89": {
      "id": "f89",
      "companyId": "c64",
      "name": "东莞松山湖覆铜板厂",
      "location": "东莞市松山湖园区南山路 6 号",
      "contact": "梁伟 · 137-2299-6600",
      "note": "FR-4 无卤覆铜板压合。",
      "extraFields": {
        "月产能": "8 万张"
      }
    }
  },
  "relationships": {
    "n5": {
      "c44": [
        "c45"
      ]
    },
    "n7": {
      "c44": [
        "c46",
        "c47"
      ]
    },
    "n9": {
      "c44": [
        "c48"
      ]
    },
    "n11": {
      "c44": [
        "c49"
      ]
    },
    "n13": {
      "c44": [
        "c50"
      ]
    },
    "n19": {
      "c45": [
        "c52"
      ]
    },
    "n21": {
      "c45": [
        "c53"
      ]
    },
    "n23": {
      "c45": [
        "c54"
      ]
    },
    "n25": {
      "c46": [
        "c55"
      ],
      "c47": [
        "c55"
      ]
    },
    "n27": {
      "c46": [
        "c56"
      ],
      "c47": [
        "c56"
      ]
    },
    "n29": {
      "c48": [
        "c57"
      ]
    },
    "n31": {
      "c48": [
        "c58"
      ]
    },
    "n33": {
      "c49": [
        "c59"
      ]
    },
    "n35": {
      "c49": [
        "c60"
      ]
    },
    "n37": {
      "c50": [
        "c61"
      ]
    },
    "n39": {
      "c50": [
        "c62"
      ]
    },
    "n41": {
      "c57": [
        "c63"
      ]
    },
    "n43": {
      "c63": [
        "c64"
      ]
    }
  },
  "factoryLinks": {
    "n5": {
      "c44": {
        "c45": [
          {
            "receiverFactoryId": "f65",
            "supplierFactoryId": "f67"
          },
          {
            "receiverFactoryId": "f66",
            "supplierFactoryId": "f68"
          }
        ]
      }
    },
    "n7": {
      "c44": {
        "c46": [
          {
            "receiverFactoryId": "f65",
            "supplierFactoryId": "f69"
          },
          {
            "receiverFactoryId": "f66",
            "supplierFactoryId": "f70"
          }
        ],
        "c47": [
          {
            "receiverFactoryId": "f66",
            "supplierFactoryId": "f71"
          }
        ]
      }
    },
    "n9": {
      "c44": {
        "c48": [
          {
            "receiverFactoryId": "f65",
            "supplierFactoryId": "f72"
          },
          {
            "receiverFactoryId": "f66",
            "supplierFactoryId": "f73"
          }
        ]
      }
    },
    "n11": {
      "c44": {
        "c49": [
          {
            "receiverFactoryId": "f65",
            "supplierFactoryId": "f74"
          }
        ]
      }
    },
    "n13": {
      "c44": {
        "c50": [
          {
            "receiverFactoryId": "f65",
            "supplierFactoryId": "f75"
          }
        ]
      }
    },
    "n19": {
      "c45": {
        "c52": [
          {
            "receiverFactoryId": "f67",
            "supplierFactoryId": "f77"
          }
        ]
      }
    },
    "n21": {
      "c45": {
        "c53": [
          {
            "receiverFactoryId": "f68",
            "supplierFactoryId": "f78"
          }
        ]
      }
    },
    "n25": {
      "c46": {
        "c55": [
          {
            "receiverFactoryId": "f69",
            "supplierFactoryId": "f80"
          }
        ]
      },
      "c47": {
        "c55": [
          {
            "receiverFactoryId": "f71",
            "supplierFactoryId": "f80"
          }
        ]
      }
    },
    "n27": {
      "c46": {
        "c56": [
          {
            "receiverFactoryId": "f70",
            "supplierFactoryId": "f81"
          }
        ]
      },
      "c47": {
        "c56": [
          {
            "receiverFactoryId": "f71",
            "supplierFactoryId": "f81"
          }
        ]
      }
    },
    "n29": {
      "c48": {
        "c57": [
          {
            "receiverFactoryId": "f72",
            "supplierFactoryId": "f82"
          }
        ]
      }
    },
    "n31": {
      "c48": {
        "c58": [
          {
            "receiverFactoryId": "f73",
            "supplierFactoryId": "f83"
          }
        ]
      }
    },
    "n33": {
      "c49": {
        "c59": [
          {
            "receiverFactoryId": "f74",
            "supplierFactoryId": "f84"
          }
        ]
      }
    },
    "n35": {
      "c49": {
        "c60": [
          {
            "receiverFactoryId": "f74",
            "supplierFactoryId": "f85"
          }
        ]
      }
    },
    "n37": {
      "c50": {
        "c61": [
          {
            "receiverFactoryId": "f75",
            "supplierFactoryId": "f86"
          }
        ]
      }
    },
    "n39": {
      "c50": {
        "c62": [
          {
            "receiverFactoryId": "f75",
            "supplierFactoryId": "f87"
          }
        ]
      }
    },
    "n41": {
      "c57": {
        "c63": [
          {
            "receiverFactoryId": "f82",
            "supplierFactoryId": "f88"
          }
        ]
      }
    },
    "n43": {
      "c63": {
        "c64": [
          {
            "receiverFactoryId": "f88",
            "supplierFactoryId": "f89"
          }
        ]
      }
    }
  }
};
