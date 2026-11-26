"use strict";
// BOM 定义、公司与工厂实体彼此独立；关系只表达是否供货，不储存供货占比。
const FORMAT="bom-flow", STORAGE_KEY="bom-flow-sim-v5", LEGACY_STORAGE_KEY="bom-flow-user-work-v1";
// 旧供应链风险评分仅作为历史数据保留，不再参与市场准入判断。
// 当前版沿用原 localStorage 键，确保已有本机工作区升级时不丢失。
const ASSESSMENT_MARKETS = [
  {key:"cn",label:"China Mainland"},{key:"eu",label:"European Union"},{key:"us",label:"United States"},
  {key:"uk",label:"United Kingdom"},{key:"jp",label:"Japan"},{key:"kr",label:"South Korea"},
  {key:"ca",label:"Canada"},{key:"au",label:"Australia"},{key:"in",label:"India"}
];
const ASSESSMENT_STATUSES = [
  {key:"pending",label:"Pending"},{key:"verified",label:"Verified"},
  {key:"blocked",label:"Blocked"}
];
// 供应链风险类别为固定枚举：仅用于旧版历史记录的兼容校验。
const RISK_CATEGORY_KEYS=["supply","quality","delivery","geo","finance","transparency","concentration","logistics"];
// 公司合规状态统一为四色制度：未填写时默认灰色「尚未核实」，不代表合格或违规。
const COMPLIANCE_STATUSES=[
  {key:"severe",label:"Severe",rank:0,description:"Confirmed severe compliance violation"},
  {key:"risk",label:"At Risk",rank:1,description:"Potential compliance issue requiring review"},
  {key:"qualified",label:"Compliant",rank:3,description:"Verified compliant with evidence"},
  {key:"unverified",label:"Unverified",rank:2,description:"Not yet assessed"}
];
const COMPLIANCE_STATUS_KEYS=COMPLIANCE_STATUSES.map(item=>item.key);
const DEFAULT_COMPLIANCE_STATUS="unverified";
const clone=value=>JSON.parse(JSON.stringify(value));
const emptyState=()=>({format:FORMAT,version:7,counter:0,activeDiagramId:null,diagrams:[],nodes:{},materials:{},companies:{},factories:{},relationships:{},factoryLinks:{}});
const values=obj=>Object.values(obj);
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const finite=n=>typeof n==="number"&&Number.isFinite(n);
function nextId(s,prefix){let id;do{id=prefix+(++s.counter);}while(s.nodes[id]||s.materials[id]||s.companies[id]||s.factories[id]||s.mergedCompanyArchives?.[id]||s.diagrams.some(d=>d.id===id));return id;}
function diagramOf(s,nid){return s.diagrams.find(d=>d.id===s.nodes[nid]?.diagramId)||null;}
function childrenOf(s,nid){return values(s.nodes).filter(n=>n.parentId===nid);}
function groupOf(s,nid){return s.nodes[nid]?.companyIds||[];}
function materialOf(s,nid){return s.materials[s.nodes[nid]?.materialId]||null;}
function nameOf(s,nid){return materialOf(s,nid)?.name||"";}
function factoryOf(s,fid){return s.factories[fid]||null;}
function factoriesOf(s,cid){return values(s.factories).filter(f=>f.companyId===cid);}
function walk(s,nid){const result=[],todo=[nid],seen=new Set();while(todo.length){const id=todo.pop();if(seen.has(id)||!s.nodes[id])continue;seen.add(id);result.push(id);todo.push(...childrenOf(s,id).map(n=>n.id).reverse());}return result;}
// 沿当前 BOM 的供货关系向上游遍历：relationships[nid][down] 中的 up 为供应方。
// 仅用于确定性提示，不产生任何准入结论。
function upstreamCompanyIds(s,did,cid){
  const diagram=s.diagrams.find(item=>item.id===did);
  if(!diagram||!s.companies[cid])return [];
  const nodeIds=walk(s,diagram.rootNodeId),seen=new Set([cid]),result=[],queue=[cid];
  while(queue.length){
    const down=queue.shift();
    for(const nid of nodeIds){
      const suppliers=s.relationships[nid]?.[down];
      if(!Array.isArray(suppliers))continue;
      for(const up of suppliers){
        if(seen.has(up)||!s.companies[up])continue;
        seen.add(up);result.push(up);queue.push(up);
      }
    }
  }
  return result;
}
// 公司总览的下游追溯：跨全部 BOM 汇总“供应方 → 接收方”关系，返回可达节点与唯一有向边。
// 只读取已建立的供货关系；不推断、不补全缺失关系。
function companyDownstreamGraph(s,cid){
  const graph={root:cid,nodes:[],edges:[],adjacency:new Map()};
  if(!s.companies[cid])return graph;
  const adjacency=new Map();
  for(const rows of values(s.relationships||{})){
    if(!rows||typeof rows!=="object")continue;
    for(const [down,ups] of Object.entries(rows)){
      if(!s.companies[down]||!Array.isArray(ups))continue;
      for(const up of ups){
        if(!s.companies[up]||up===down)continue;
        if(!adjacency.has(up))adjacency.set(up,new Set());
        adjacency.get(up).add(down);
      }
    }
  }
  const seen=new Set([cid]),nodes=[cid],edges=[],queue=[cid];
  while(queue.length){
    const up=queue.shift();
    for(const down of adjacency.get(up)||[]){
      if(!seen.has(down)){seen.add(down);nodes.push(down);queue.push(down);}
      edges.push([up,down]);
    }
  }
  graph.nodes=nodes;graph.edges=edges;graph.adjacency=adjacency;
  return graph;
}
function addMaterial(s,name){const id=nextId(s,"m");s.materials[id]={id,name:name.trim(),code:"",note:""};return id;}
function addDocument(s,name){if(!name.trim())throw Error("Enter a finished product name");const id=nextId(s,"d"),mid=addMaterial(s,name),nid=nextId(s,"n");s.nodes[nid]={id:nid,diagramId:id,materialId:mid,parentId:null,companyIds:[],qty:1,unit:"",x:80,y:100};s.diagrams.push({id,rootNodeId:nid,risks:{},assessments:{}});s.activeDiagramId=id;return nid;}
function addNode(s,parentId,{name,materialId,qty,unit}){const parent=s.nodes[parentId];if(!parent)throw Error("Select a parent component");if(!finite(qty)||qty<=0)throw Error("Quantity per unit must be greater than 0");if(!materialId&&!name.trim())throw Error("Enter a component name");if(materialId&&!s.materials[materialId])throw Error("Component definition not found");for(let p=parent;p;p=s.nodes[p.parentId])if(materialId&&p.materialId===materialId)throw Error("A component cannot contain itself");const mid=materialId||addMaterial(s,name);const id=nextId(s,"n"),siblings=childrenOf(s,parentId),x=parent.x+330;let y=parent.y+siblings.length*170;while(values(s.nodes).some(n=>n.diagramId===parent.diagramId&&Math.abs(n.x-x)<250&&Math.abs(n.y-y)<150))y+=170;s.nodes[id]={id,diagramId:parent.diagramId,materialId:mid,parentId,companyIds:[],qty,unit:unit.trim(),x,y};return id;}
function reparent(s,nid,parentId){const node=s.nodes[nid],parent=s.nodes[parentId];if(!node||!parent)throw Error("Component not found");if(node.parentId===null)throw Error("Finished product node cannot be a child component");if(node.diagramId!==parent.diagramId)throw Error("Components must belong to the same BOM");if(walk(s,nid).includes(parentId))throw Error("Connection would create a cycle");if(node.parentId===parentId)return false;const descendants=new Set(walk(s,nid).map(id=>s.nodes[id].materialId));for(let p=parent;p;p=s.nodes[p.parentId])if(descendants.has(p.materialId))throw Error("Connection would make a component contain itself");node.parentId=parentId;delete s.relationships[nid];delete s.factoryLinks[nid];return true;}
// 全局主体按规范化名称匹配；节点只存公司 ID，供货关系仍按连线独立保存。
function normalizedCompanyName(name){return String(name||"").normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();}
function findCompanyByName(s,name,exceptId=null){const key=normalizedCompanyName(name);return values(s.companies).find(c=>c.id!==exceptId&&normalizedCompanyName(c.name)===key)||null;}
function duplicateCompanyGroups(s){const byName=new Map();for(const c of values(s.companies)){const key=normalizedCompanyName(c.name);if(!byName.has(key))byName.set(key,[]);byName.get(key).push(c);}return [...byName.values()].filter(group=>group.length>1);}
function addCompany(s,name,fields={}){name=name.trim();if(!name)throw Error("Enter a company name");const duplicate=findCompanyByName(s,name);if(duplicate)throw Error(`"${duplicate.name}" already exists in the company directory`);const id=nextId(s,"c");s.companies[id]={id,name,location:"",contact:"",note:"",extraFields:{},compliance:{status:DEFAULT_COMPLIANCE_STATUS,reason:"",updatedAt:null,legacyScore:null},...fields};if(fields.compliance)setCompanyCompliance(s,id,fields.compliance);return{id,reused:false};}
// 旧版 0–100 分数只在迁移时归入四色状态，并保留为 legacyScore 供追溯。
function complianceStatusFromScore(score){
  if(!finite(score)||score<0||score>100)return DEFAULT_COMPLIANCE_STATUS;
  if(score<60)return "severe";
  if(score<75)return "risk";
  return "qualified";
}
function normalizeCompliance(value){
  const source=value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  let status=COMPLIANCE_STATUS_KEYS.includes(source.status)?source.status:null;
  let legacyScore=finite(source.legacyScore)&&source.legacyScore>=0&&source.legacyScore<=100?Math.round(source.legacyScore):null;
  if(status===null){
    if(finite(source.score)&&source.score>=0&&source.score<=100){
      legacyScore=Math.round(source.score);
      status=complianceStatusFromScore(source.score);
    }else status=DEFAULT_COMPLIANCE_STATUS;
  }
  return {
    status,
    reason:typeof source.reason==="string"?source.reason.slice(0,5000):"",
    updatedAt:Number.isSafeInteger(source.updatedAt)?source.updatedAt:null,
    legacyScore
  };
}
// 合规状态是人工判断：未填写时默认「尚未核实」，不能自动视为合格。
function setCompanyCompliance(s,cid,input={}){
  const company=s.companies[cid];
  if(!company)throw Error("Company not found");
  const current=normalizeCompliance(company.compliance);
  const status=input.status===undefined?current.status:input.status;
  if(!COMPLIANCE_STATUS_KEYS.includes(status))throw Error("Invalid compliance status");
  const reason=String(input.reason??"").trim();
  if(reason.length>5000)throw Error("Compliance rationale must not exceed 5000 characters");
  const requestedLegacy=finite(input.legacyScore)&&input.legacyScore>=0&&input.legacyScore<=100?Math.round(input.legacyScore):null;
  company.compliance={
    status,reason,
    updatedAt:status===DEFAULT_COMPLIANCE_STATUS&&!reason?null:Date.now(),
    legacyScore:requestedLegacy??current.legacyScore
  };
  return company.compliance;
}
// 供应链风险评定挂在 BOM 上：同一家成品公司在不同产品的供应链中风险不同。
function setRiskAssessment(s,did,cid,input={}){
  const diagram=s.diagrams.find(d=>d.id===did);
  if(!diagram)throw Error("BOM not found");
  if(!s.companies[cid])throw Error("Company not found");
  if(input.score===null||input.score===undefined||input.score==="")throw Error("Risk score must be between 0 and 100");
  const score=Number(input.score);
  if(!Number.isFinite(score)||score<0||score>100)throw Error("Risk score must be between 0 and 100");
  const categories=[...new Set(Array.isArray(input.categories)?input.categories:[])];
  if(categories.length>RISK_CATEGORY_KEYS.length||categories.some(key=>!RISK_CATEGORY_KEYS.includes(key)))throw Error("Invalid risk category");
  const note=String(input.note??"").trim();
  if(note.length>5000)throw Error("Risk note must not exceed 5000 characters");
  diagram.risks??={};
  diagram.risks[cid]={score:Math.round(score),categories,note,updatedAt:Date.now()};
  return diagram.risks[cid];
}
function clearRiskAssessment(s,did,cid){
  const diagram=s.diagrams.find(d=>d.id===did);
  if(!diagram?.risks)return false;
  if(!own(diagram.risks,cid))return false;
  delete diagram.risks[cid];
  return true;
}
// 市场准入：以 BOM / 成品评估主体 / 目标市场为独立记录。
// status 是人工确认的状态；证据与待核实事项均由人工录入。
function assessmentOf(s,did,cid,market){
  return s.diagrams.find(d=>d.id===did)?.assessments?.[cid]?.[market] || null;
}
function validateAssessmentRecord(value){
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid market access assessment format");
  if(!ASSESSMENT_STATUSES.some(item=>item.key===value.status))throw Error("Invalid market access status");
  if(!Array.isArray(value.evidence)||!Array.isArray(value.pendingItems))throw Error("Invalid evidence or pending items format");
  if(value.evidence.length>300||value.pendingItems.length>300)throw Error("At most 300 evidence or pending items per assessment");
  const check=(items,kind)=>{
    const seen=new Set();
    for(const item of items){
      if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.id!=="string"||!/^a[0-9a-z_-]{1,40}$/.test(item.id)||seen.has(item.id))throw Error("Invalid " + kind + " ID");
      seen.add(item.id);
      if(typeof item.title!=="string"||!item.title.trim()||item.title.length>120||typeof item.detail!=="string"||item.detail.length>3000)throw Error("Invalid " + kind + " content");
      if(kind==="evidence"&&(typeof item.source!=="string"||item.source.length>1000))throw Error("Invalid evidence source");
    }
  };
  check(value.evidence,"evidence");check(value.pendingItems,"pending item");
  if(value.status!=="pending"&&!value.evidence.length)throw Error("Add at least one piece of evidence before confirming status");
  if(value.status==="verified"&&value.pendingItems.length)throw Error("Cannot mark Verified while pending items remain");
  if(!(value.updatedAt===null||Number.isSafeInteger(value.updatedAt)))throw Error("Invalid assessment timestamp");
  return true;
}
function setMarketAssessment(s,did,cid,market,input={}){
  const d=s.diagrams.find(item=>item.id===did);
  if(!d)throw Error("BOM not found");
  if(!s.companies[cid]||!groupOf(s,d.rootNodeId).includes(cid))throw Error("Subject must be linked to the finished product node");
  if(!ASSESSMENT_MARKETS.some(item=>item.key===market))throw Error("Select a valid target market");
  const record={
    status:input.status??"pending",
    evidence:clone(input.evidence??[]),
    pendingItems:clone(input.pendingItems??[]),
    updatedAt:Date.now()
  };
  validateAssessmentRecord(record);
  d.assessments??={}; d.assessments[cid]??={};
  d.assessments[cid][market]=record;
  return record;
}
function clearMarketAssessment(s,did,cid,market){
  const d=s.diagrams.find(item=>item.id===did);
  if(!d?.assessments?.[cid]||!Object.prototype.hasOwnProperty.call(d.assessments[cid],market))return false;
  delete d.assessments[cid][market];
  if(!Object.keys(d.assessments[cid]).length)delete d.assessments[cid];
  return true;
}
function assignCompany(s,nid,cid){
  if(!s.companies[cid]||!s.nodes[nid])throw Error("Company or component not found");
  const ids=groupOf(s,nid);
  if(!ids.includes(cid))ids.push(cid);
}
function hasCompanyLink(s,nid,down,up){return (s.relationships[nid]?.[down]||[]).includes(up);}
function linkCompany(s,nid,down,up){const n=s.nodes[nid];if(!n?.parentId||!groupOf(s,nid).includes(up)||!groupOf(s,n.parentId).includes(down))throw Error("Link both companies to their components first");s.relationships[nid]??={};s.relationships[nid][down]??=[];if(s.relationships[nid][down].includes(up))return false;s.relationships[nid][down].push(up);return true;}
function unlinkCompany(s,nid,down,up){const row=s.relationships[nid]?.[down];if(!row)return;const i=row.indexOf(up);if(i>=0)row.splice(i,1);if(!row.length)delete s.relationships[nid][down];delete s.factoryLinks[nid]?.[down]?.[up];cleanupRelations(s);}
function addFactory(s,cid,name,fields={}){if(!s.companies[cid])throw Error("Parent company not found");if(!name.trim())throw Error("Enter a factory name");const id=nextId(s,"f");s.factories[id]={id,companyId:cid,name:name.trim(),location:"",contact:"",note:"",extraFields:{},...fields};return id;}
function removeFactory(s,fid){if(!s.factories[fid])return;delete s.factories[fid];cleanupRelations(s);}
function getFactoryLinks(s,nid,down,up){return s.factoryLinks[nid]?.[down]?.[up]||[];}
function linkFactory(s,nid,down,up,receiverFactoryId,supplierFactoryId){if(!hasCompanyLink(s,nid,down,up))throw Error("Create the company supply link first");if(s.factories[receiverFactoryId]?.companyId!==down||s.factories[supplierFactoryId]?.companyId!==up)throw Error("Factory ownership does not match the supply link");const a=s.factoryLinks[nid]??={},b=a[down]??={},arr=b[up]??=[];if(arr.some(e=>e.receiverFactoryId===receiverFactoryId&&e.supplierFactoryId===supplierFactoryId))return false;arr.push({receiverFactoryId,supplierFactoryId});return true;}
function unlinkFactory(s,nid,down,up,receiverFactoryId,supplierFactoryId){const arr=getFactoryLinks(s,nid,down,up);const i=arr.findIndex(e=>e.receiverFactoryId===receiverFactoryId&&e.supplierFactoryId===supplierFactoryId);if(i>=0)arr.splice(i,1);cleanupRelations(s);}
function cleanupRelations(s){for(const [nid,rows] of Object.entries(s.relationships)){const n=s.nodes[nid];if(!n?.parentId){delete s.relationships[nid];continue;}for(const [down,ups] of Object.entries(rows)){if(!groupOf(s,n.parentId).includes(down)){delete rows[down];continue;}rows[down]=ups.filter(up=>groupOf(s,nid).includes(up));if(!rows[down].length)delete rows[down];}if(!Object.keys(rows).length)delete s.relationships[nid];}for(const [nid,rows] of Object.entries(s.factoryLinks)){for(const [down,groups] of Object.entries(rows)){for(const [up,pairs] of Object.entries(groups)){if(!hasCompanyLink(s,nid,down,up)){delete groups[up];continue;}groups[up]=pairs.filter(e=>s.factories[e.receiverFactoryId]?.companyId===down&&s.factories[e.supplierFactoryId]?.companyId===up);if(!groups[up].length)delete groups[up];}if(!Object.keys(groups).length)delete rows[down];}if(!Object.keys(rows).length)delete s.factoryLinks[nid];}}
function removeCompanyFromGroup(s,nid,cid){const n=s.nodes[nid];if(!n)return;n.companyIds=n.companyIds.filter(id=>id!==cid);cleanupRelations(s);}
function deleteSubtree(s,nid){const n=s.nodes[nid];if(!n?.parentId)throw Error("Delete the entire BOM from the BOM menu");for(const id of walk(s,nid)){delete s.relationships[id];delete s.factoryLinks[id];delete s.nodes[id];}cleanupRelations(s);}
function deleteDocument(s,did){const d=s.diagrams.find(d=>d.id===did);if(!d)return;for(const id of walk(s,d.rootNodeId)){delete s.nodes[id];delete s.relationships[id];delete s.factoryLinks[id];}s.diagrams=s.diagrams.filter(x=>x.id!==did);s.activeDiagramId=s.diagrams[0]?.id||null;}
// 对历史重复档案执行用户确认后的合并；不清除任何独立的组件连线。
function mergeCompanyRecords(s,keepId,removeIds){
  const keep=s.companies[keepId];
  if(!keep)throw Error("Target company record not found");
  const key=normalizedCompanyName(keep.name);
  const sources=[...new Set(removeIds)].filter(id=>id!==keepId);
  if(!sources.length)throw Error("No companies selected to merge");
  for(const id of sources){if(!s.companies[id]||normalizedCompanyName(s.companies[id].name)!==key)throw Error("Only duplicate companies with the same name can be merged");}
  s.mergedCompanyArchives??={};
  for(const id of sources){
    const source=s.companies[id];
    // 完整保留原档案，包含不同的地址、联系方式、备注与自定义字段，供后续审查。
    s.mergedCompanyArchives[id]={...clone(source),mergedInto:keepId};
    for(const field of ["location","contact","note"]){if(!keep[field]&&source[field])keep[field]=source[field];}
    keep.extraFields??={};
    for(const [field,value] of Object.entries(source.extraFields||{})){
      if(!own(keep.extraFields,field)&&Object.keys(keep.extraFields).length<60)keep.extraFields[field]=value;
    }
    // 主档案尚未核实时，继承被合并档案的合规状态；风险评定按 BOM 重新指向主档案。
    const keepCompliance=normalizeCompliance(keep.compliance),sourceCompliance=normalizeCompliance(source.compliance);
    const keepEmpty=keepCompliance.status===DEFAULT_COMPLIANCE_STATUS&&!keepCompliance.reason;
    const sourceFilled=sourceCompliance.status!==DEFAULT_COMPLIANCE_STATUS||!!sourceCompliance.reason;
    keep.compliance=keepEmpty&&sourceFilled?sourceCompliance:keepCompliance;
    for(const diagram of s.diagrams){
      if(!diagram.risks||!own(diagram.risks,id))continue;
      if(!own(diagram.risks,keepId))diagram.risks[keepId]=diagram.risks[id];
      delete diagram.risks[id];
    }
    // 合并同名档案时同步迁移新市场评估；冲突时保留双方资料并要求重新核实。
    for(const diagram of s.diagrams){
      const incoming=diagram.assessments?.[id];
      if(!incoming)continue;
      diagram.assessments[keepId]??={};
      for(const [market,record] of Object.entries(incoming)){
        const existing=diagram.assessments[keepId][market];
        if(!existing){diagram.assessments[keepId][market]=record;continue;}
        const join=(left,right)=>{
          const combined=clone(left),ids=new Set(combined.map(item=>item.id));let next=0;
          for(const original of right){
            let id=original.id;
            while(ids.has(id))id="amerge"+(++next);
            ids.add(id);combined.push({...clone(original),id});
          }
          return combined;
        };
        diagram.assessments[keepId][market]={
          status:"pending", evidence:join(existing.evidence,record.evidence),
          pendingItems:join(existing.pendingItems,record.pendingItems),updatedAt:Date.now()
        };
      }
      delete diagram.assessments[id];
    }
    for(const n of values(s.nodes)){
      n.companyIds=[...new Set(n.companyIds.map(cid=>cid===id?keepId:cid))];
    }
    for(const [nid,byDown] of Object.entries(s.relationships)){
      const next={};
      for(const [down,ups] of Object.entries(byDown)){
        const d=down===id?keepId:down;
        const row=next[d]??=[];
        for(const up of ups){const u=up===id?keepId:up;if(!row.includes(u))row.push(u);}
      }
      s.relationships[nid]=next;
    }
    for(const [nid,byDown] of Object.entries(s.factoryLinks)){
      const next={};
      for(const [down,byUp] of Object.entries(byDown)){
        const d=down===id?keepId:down;
        for(const [up,pairs] of Object.entries(byUp)){
          const u=up===id?keepId:up, arr=(next[d]??={})[u]??=[];
          for(const pair of pairs){
            if(!arr.some(p=>p.receiverFactoryId===pair.receiverFactoryId&&p.supplierFactoryId===pair.supplierFactoryId))arr.push(pair);
          }
        }
      }
      s.factoryLinks[nid]=next;
    }
    for(const factory of values(s.factories))if(factory.companyId===id)factory.companyId=keepId;
    delete s.companies[id];
  }
  cleanupRelations(s);
  return sources.length;
}
function migrateLegacy(raw){
  const s=clone(raw);
  if(s.version===1){
    s.relationships={};
    for(const [nid,rows] of Object.entries(s.allocations||{}))for(const [down,ups] of Object.entries(rows)){
      const ids=Object.keys(ups);if(ids.length)(s.relationships[nid]??={})[down]=ids;
    }
    s.factories={};s.factoryLinks={};delete s.allocations;s.version=2;
  }
  if(s.version===2){
    // v1/v2: 公司主体原本属于全局公司库，只是组件引用保存在组件定义上。
    // v4 按“主体全局复用、节点引用独立、连线关系独立”直接迁移，不复制主体或工厂。
    for(const node of values(s.nodes)){
      const oldIds=s.materials[node.materialId]?.companyIds||[];
      node.companyIds=[...new Set(oldIds.filter(cid=>own(s.companies,cid)))];
    }
    for(const material of values(s.materials))delete material.companyIds;
    s.relationships??={};s.factories??={};s.factoryLinks??={};
    cleanupRelations(s);
    s.version=4;
  }
  if(s.version===3)s.version=4;
  if(s.version===4){
    // v5: 公司增加可选合规评估，BOM 增加成品公司的供应链风险评定。
    for(const company of values(s.companies||{}))company.compliance=normalizeCompliance(company.compliance);
    for(const diagram of s.diagrams||[]){
      if(!diagram.risks||typeof diagram.risks!=="object"||Array.isArray(diagram.risks))diagram.risks={};
    }
    s.version=5;
  }
  if(s.version===5){
    // v6: 不把历史评分映射为准入结论；所有市场评估均从空白人工记录开始。
    for(const diagram of s.diagrams||[])diagram.assessments??={};
    s.version=6;
  }
  if(s.version===6){
    // v7: 公司合规由 0–100 分数统一为四色状态；旧分数归档为 legacyScore。
    for(const company of values(s.companies||{}))company.compliance=normalizeCompliance(company.compliance);
    s.version=7;
  }
  return s;
}
function validateState(raw){if(!raw||raw.format!==FORMAT||![1,2,3,4,5,6,7].includes(raw.version))throw Error("Select a valid BOM JSON export file");const s=migrateLegacy(raw);if(!Number.isSafeInteger(s.counter)||s.counter<0||s.counter>1e9||!Array.isArray(s.diagrams))throw Error("Invalid file structure");for(const key of ["nodes","materials","companies","factories","relationships","factoryLinks"])if(!s[key]||typeof s[key]!=="object"||Array.isArray(s[key]))throw Error("Missing field: "+key);
const safe=id=>typeof id==="string"&&/^[a-z][a-zA-Z0-9_-]{0,79}$/.test(id)&&!["constructor","prototype","__proto__"].includes(id);const str=v=>typeof v==="string"&&v.length<=20000;
for(const key of ["nodes","materials","companies","factories","relationships","factoryLinks"])for(const id of Object.keys(s[key]))if(!safe(id))throw Error("File contains invalid IDs");
const validExtra=extra=>extra===undefined||(extra!==null&&typeof extra==="object"&&!Array.isArray(extra)&&Object.entries(extra).length<=60&&Object.entries(extra).every(([k,v])=>k.length>0&&k.length<=80&&str(v)&&v.length<=5000));
const docIds=new Set();for(const d of s.diagrams){if(!safe(d.id)||docIds.has(d.id)||!own(s.nodes,d.rootNodeId))throw Error("Invalid BOM ID");docIds.add(d.id);
  if(!d.risks||typeof d.risks!=="object"||Array.isArray(d.risks))d.risks={};
  for(const [cid,r] of Object.entries(d.risks)){
    if(!own(s.companies,cid))throw Error("Invalid company reference in risk rating");
    if(!r||typeof r!=="object"||Array.isArray(r))throw Error("Invalid risk rating format");
    if(!(r.score===null||(finite(r.score)&&r.score>=0&&r.score<=100)))throw Error("Risk score must be between 0 and 100");
    if(!Array.isArray(r.categories)||r.categories.length>RISK_CATEGORY_KEYS.length||new Set(r.categories).size!==r.categories.length||r.categories.some(key=>!RISK_CATEGORY_KEYS.includes(key)))throw Error("Invalid risk category");
    if(!str(r.note)||r.note.length>5000)throw Error("Invalid risk note");
    if(!(r.updatedAt===null||Number.isSafeInteger(r.updatedAt)))throw Error("Invalid risk rating timestamp");
  }
  if(!d.assessments||typeof d.assessments!=="object"||Array.isArray(d.assessments))throw Error("Invalid market access assessment structure");
  for(const [cid,byMarket] of Object.entries(d.assessments)){
    if(!own(s.companies,cid))throw Error("Invalid company reference in assessment");
    // 解除成品节点公司引用时，历史记录暂时休眠而非删除；重新关联后仍可找回。
    if(!byMarket||typeof byMarket!=="object"||Array.isArray(byMarket))throw Error("Invalid target market assessment format");
    for(const [market,record] of Object.entries(byMarket)){
      if(!ASSESSMENT_MARKETS.some(item=>item.key===market))throw Error("Invalid target market");
      validateAssessmentRecord(record);
    }
  }
}
for(const [id,m] of Object.entries(s.materials))if(m.id!==id||!str(m.name)||!m.name.trim()||!str(m.code)||!str(m.note))throw Error("Invalid component data or company reference");
const validCompliance=c=>{if(!c||typeof c!=="object"||Array.isArray(c))return false;const {status,reason,updatedAt,legacyScore}=c;return COMPLIANCE_STATUS_KEYS.includes(status)&&typeof reason==="string"&&reason.length<=5000&&(updatedAt===null||Number.isSafeInteger(updatedAt))&&(legacyScore===null||legacyScore===undefined||(finite(legacyScore)&&legacyScore>=0&&legacyScore<=100));};
for(const [id,c] of Object.entries(s.companies))if(c.id!==id||![c.name,c.location,c.contact,c.note].every(str)||!c.name.trim()||!validExtra(c.extraFields)||!validCompliance(c.compliance))throw Error("Invalid company data");
for(const [id,f] of Object.entries(s.factories))if(f.id!==id||!own(s.companies,f.companyId)||![f.name,f.location,f.contact,f.note].every(str)||!f.name.trim()||!validExtra(f.extraFields))throw Error("Invalid factory data");
const visited=new Set();for(const d of s.diagrams){const root=s.nodes[d.rootNodeId];if(root.parentId!==null||root.diagramId!==d.id)throw Error("Invalid finished product node reference");for(const id of walk(s,d.rootNodeId)){if(visited.has(id))throw Error("Duplicate BOM node reference");visited.add(id);}}if(visited.size!==Object.keys(s.nodes).length)throw Error("Disconnected component or cycle detected");
for(const [id,n] of Object.entries(s.nodes)){const ancestors=new Set();for(let p=n;p;p=s.nodes[p.parentId]){if(ancestors.has(p.materialId))throw Error("Component definition references itself");ancestors.add(p.materialId);}if(n.id!==id||!Array.isArray(n.companyIds)||new Set(n.companyIds).size!==n.companyIds.length||n.companyIds.some(cid=>!own(s.companies,cid))||!own(s.materials,n.materialId)||!docIds.has(n.diagramId)||!finite(n.qty)||n.qty<=0||!str(n.unit)||!finite(n.x)||!finite(n.y)||Math.abs(n.x)>1e7||Math.abs(n.y)>1e7)throw Error("Invalid component position or quantity");if(n.parentId!==null&&(!own(s.nodes,n.parentId)||s.nodes[n.parentId].diagramId!==n.diagramId))throw Error("Invalid parent component reference");if(n.parentId===null&&!s.diagrams.some(d=>d.rootNodeId===id))throw Error("A BOM can only have one root product node");}
for(const [nid,rows] of Object.entries(s.relationships)){const n=s.nodes[nid];if(!n?.parentId||!rows||typeof rows!=="object"||Array.isArray(rows))throw Error("Invalid supply relationship reference");for(const [down,ups] of Object.entries(rows)){if(!safe(down)||!groupOf(s,n.parentId).includes(down)||!Array.isArray(ups)||!ups.length||new Set(ups).size!==ups.length||ups.some(up=>!safe(up)||!groupOf(s,nid).includes(up)))throw Error("Invalid company supply relationship");}}
for(const [nid,rows] of Object.entries(s.factoryLinks)){if(!own(s.nodes,nid)||!rows||typeof rows!=="object"||Array.isArray(rows))throw Error("Invalid factory link reference");for(const [down,groups] of Object.entries(rows)){if(!safe(down)||!groups||typeof groups!=="object"||Array.isArray(groups))throw Error("Invalid factory receiver reference");for(const [up,pairs] of Object.entries(groups)){if(!safe(up)||!hasCompanyLink(s,nid,down,up)||!Array.isArray(pairs)||!pairs.length)throw Error("Factory link missing corresponding company link");const uniq=new Set();for(const p of pairs){if(s.factories[p.receiverFactoryId]?.companyId!==down||s.factories[p.supplierFactoryId]?.companyId!==up)throw Error("Factory company mismatch");const key=p.receiverFactoryId+":"+p.supplierFactoryId;if(uniq.has(key))throw Error("Duplicate factory link");uniq.add(key);}}}}
if(s.activeDiagramId!==null&&!docIds.has(s.activeDiagramId))throw Error("Invalid active BOM reference");if(s.diagrams.length&&!s.activeDiagramId)s.activeDiagramId=s.diagrams[0].id;return s;}
