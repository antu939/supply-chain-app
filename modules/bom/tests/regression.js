/** BOM v7 数据模型回归测试：在 Node.js 中执行 `node tests/regression.js`。 */
const fs=require('fs');const vm=require('vm');const assert=require('assert/strict');
const source=fs.readFileSync(require('path').join(__dirname,'..','js','model.js'),'utf8');
const m={};vm.createContext(m);vm.runInContext(source+`;
this.api={emptyState,addDocument,addNode,addCompany,assignCompany,linkCompany,unlinkCompany,hasCompanyLink,addFactory,linkFactory,getFactoryLinks,removeCompanyFromGroup,validateState,migrateLegacy,normalizedCompanyName,findCompanyByName,duplicateCompanyGroups,mergeCompanyRecords,setCompanyCompliance,setRiskAssessment,clearRiskAssessment,RISK_CATEGORY_KEYS,ASSESSMENT_MARKETS,ASSESSMENT_STATUSES,assessmentOf,setMarketAssessment,clearMarketAssessment,groupOf,clone,upstreamCompanyIds,companyDownstreamGraph,COMPLIANCE_STATUSES,COMPLIANCE_STATUS_KEYS,normalizeCompliance,complianceStatusFromScore,DEFAULT_COMPLIANCE_STATUS}`,m);
const {emptyState,addDocument,addNode,addCompany,assignCompany,linkCompany,unlinkCompany,hasCompanyLink,addFactory,linkFactory,getFactoryLinks,removeCompanyFromGroup,validateState,migrateLegacy,findCompanyByName,duplicateCompanyGroups,mergeCompanyRecords,setCompanyCompliance,setRiskAssessment,clearRiskAssessment,RISK_CATEGORY_KEYS,ASSESSMENT_MARKETS,ASSESSMENT_STATUSES,assessmentOf,setMarketAssessment,clearMarketAssessment,groupOf,clone,upstreamCompanyIds,companyDownstreamGraph,COMPLIANCE_STATUSES,COMPLIANCE_STATUS_KEYS,normalizeCompliance,complianceStatusFromScore,DEFAULT_COMPLIANCE_STATUS}=m.api;
const scenario=()=>{const s=emptyState(),a=addDocument(s,'A');const b=addNode(s,a,{name:'B',qty:1,unit:'件'}),c=addNode(s,a,{name:'C',qty:1,unit:'件'});return{s,a,b,c};};
{
  const {s,a,b,c}=scenario();const x=addCompany(s,'上海示例科技有限公司').id,r=addCompany(s,'A总装公司').id;
  assignCompany(s,a,r);assignCompany(s,b,x);assignCompany(s,c,x);
  assert.deepEqual([...groupOf(s,b)],[x]);assert.deepEqual([...groupOf(s,c)],[x]);
  assert.equal(Object.keys(s.companies).length,2);
  linkCompany(s,b,r,x);linkCompany(s,c,r,x);assert.ok(hasCompanyLink(s,b,r,x));assert.ok(hasCompanyLink(s,c,r,x));
  const fr=addFactory(s,r,'总装工厂'),fx=addFactory(s,x,'上海分厂');linkFactory(s,b,r,x,fr,fx);linkFactory(s,c,r,x,fr,fx);
  unlinkCompany(s,b,r,x);assert.ok(!hasCompanyLink(s,b,r,x));assert.ok(hasCompanyLink(s,c,r,x));
  assert.equal(getFactoryLinks(s,c,r,x).length,1,'B 线解除供货后 C 线工厂路径保留');
  removeCompanyFromGroup(s,b,x);assert.ok(groupOf(s,c).includes(x));assert.ok(s.companies[x]);
  assert.equal(validateState(s).version,7);
  assert.equal(findCompanyByName(s,' 上海示例 科技有限公司 ').id,x);
  for(const name of ['上海示例科技有限公司','  上海示例科技有限公司  ','上海示例科技有限公司 '])assert.throws(()=>addCompany(s,name),/already exists in the company directory/);
  console.log('✓ 全局公司复用 / 两条连线隔离 / 工厂路径隔离 / 全局查重');
}
{
  const {s,a,b,c}=scenario();const r=addCompany(s,'买方A').id,x=addCompany(s,'供货方X').id;
  assignCompany(s,a,r);assignCompany(s,b,x);assignCompany(s,c,x);linkCompany(s,b,r,x);linkCompany(s,c,r,x);
  const y='c998';s.companies[y]={...clone(s.companies[x]),id:y,name:'  供货方 X  ',contact:'13800138000',extraFields:{认证:'B'}};
  s.nodes[c].companyIds=[y];s.relationships[c][r]=[y];
  const f1=addFactory(s,x,'厂1'),f2=addFactory(s,y,'厂2'),fr=addFactory(s,r,'总装厂');
  linkFactory(s,b,r,x,fr,f1);linkFactory(s,c,r,y,fr,f2);
  s.version=3;
  let upgraded=validateState(s);
  assert.equal(upgraded.version,7);assert.equal(duplicateCompanyGroups(upgraded).length,1,'旧数据保持重复供人工审查');
  mergeCompanyRecords(upgraded,x,[y]);
  assert.equal(duplicateCompanyGroups(upgraded).length,0);
  assert.ok(groupOf(upgraded,c).includes(x));assert.ok(hasCompanyLink(upgraded,b,r,x));assert.ok(hasCompanyLink(upgraded,c,r,x));
  assert.equal(getFactoryLinks(upgraded,b,r,x).length,1);assert.equal(getFactoryLinks(upgraded,c,r,x).length,1);
  assert.equal(upgraded.factories[f2].companyId,x);assert.equal(upgraded.companies[x].contact,'13800138000');
  assert.equal(upgraded.mergedCompanyArchives[y].extraFields.认证,'B');
  assert.equal(validateState(upgraded).version,7);
  console.log('✓ 历史重复公司审查 / 合并 / 组件引用 / 工厂与各连线保留 / 原档案归档');
}
{
  const {s,a,b,c}=scenario();const r=addCompany(s,'总装R').id,x=addCompany(s,'厂商X').id;
  const sharedMaterial=s.nodes[b].materialId;s.nodes[c].materialId=sharedMaterial;
  s.materials[sharedMaterial].companyIds=[x];s.materials[s.nodes[a].materialId].companyIds=[r];
  delete s.nodes[a].companyIds;delete s.nodes[b].companyIds;delete s.nodes[c].companyIds;
  s.version=2;s.relationships[b]={[r]:[x]};s.relationships[c]={[r]:[x]};
  const fr=addFactory(s,r,'装配厂'),fx=addFactory(s,x,'供货工厂');s.factoryLinks[b]={[r]:{[x]:[{receiverFactoryId:fr,supplierFactoryId:fx}]}};
  const upgraded=validateState(s);
  assert.equal(upgraded.version,7);assert.ok(groupOf(upgraded,b).includes(x));assert.ok(groupOf(upgraded,c).includes(x));
  assert.equal(Object.keys(upgraded.companies).length,2,'v2 不再克隆同名公司');
  assert.ok(hasCompanyLink(upgraded,b,r,x)&&hasCompanyLink(upgraded,c,r,x));
  assert.equal(getFactoryLinks(upgraded,b,r,x).length,1);
  console.log('✓ v2 共享组件定义迁移到 v4：复用公司主体而不复制');
}
{
  const {s,a,b}=scenario();const x=addCompany(s,'x').id;assignCompany(s,b,x);
  assert.throws(()=>addCompany(s,'Ｘ'),/already exists in the company directory/,'NFKC 全角/大小写一致');
  console.log('✓ 全角与大小写归一化');
}
{
  const {s,a,b}=scenario();const r=addCompany(s,'V1 接收方').id,x=addCompany(s,'V1 供应方').id;
  s.materials[s.nodes[a].materialId].companyIds=[r];
  s.materials[s.nodes[b].materialId].companyIds=[x];
  for(const n of Object.values(s.nodes))delete n.companyIds;
  s.allocations={[b]:{[r]:{[x]:{share:1}}}};
  s.version=1;delete s.relationships;delete s.factoryLinks;delete s.factories;
  const upgraded=validateState(s);
  assert.equal(upgraded.version,7);assert.ok(hasCompanyLink(upgraded,b,r,x));
  assert.ok(groupOf(upgraded,b).includes(x));
  assert.ok(!('allocations' in upgraded));
  console.log('✓ v1 旧分配数据兼容迁移');
}
{
  const {s,a,b}=scenario(); const r=addCompany(s,'合规接收方').id,x=addCompany(s,'合规供应方').id;
  assert.equal(s.version,7);
  assert.equal(COMPLIANCE_STATUS_KEYS.join(','),'severe,risk,qualified,unverified');
  assert.equal(s.companies[x].compliance.status,'unverified');
  assert.equal(s.companies[x].compliance.reason,"");assert.equal(s.companies[x].compliance.updatedAt,null);
  // 未填写或只写原因时仍默认「尚未核实」，不能被当作合格。
  assert.equal(normalizeCompliance(null).status,'unverified');
  assert.equal(normalizeCompliance({reason:'缺少环保验收文件'}).status,'unverified');
  setCompanyCompliance(s,x,{status:'qualified',reason:'ISO 9001 有效，未见整改项'});
  assert.equal(validateState(s).companies[x].compliance.status,'qualified');
  assert.ok(Number.isSafeInteger(s.companies[x].compliance.updatedAt));
  assert.equal(s.companies[x].compliance.reason,'ISO 9001 有效，未见整改项');
  setCompanyCompliance(s,r,{reason:"缺少环保验收文件"});
  assert.equal(s.companies[r].compliance.status,'unverified');
  assert.equal(validateState(s).companies[r].compliance.reason,"缺少环保验收文件");
  assert.throws(()=>setCompanyCompliance(s,x,{status:'unknown',reason:""}),/Invalid compliance status/);
  assert.throws(()=>setCompanyCompliance(s,x,{status:'qualified',reason:"x".repeat(5001)}),/5000/);
  const bad=clone(s); bad.companies[x].compliance={status:'warning',reason:"",updatedAt:null};
  assert.throws(()=>validateState(bad),/Invalid company data/);
  // 旧分数迁移：<60 严重违规，60–74 违规风险，>=75 合格，空值未核实；旧分数保留追溯。
  assert.equal(complianceStatusFromScore(58),'severe');
  assert.equal(complianceStatusFromScore(60),'risk');
  assert.equal(complianceStatusFromScore(74),'risk');
  assert.equal(complianceStatusFromScore(75),'qualified');
  const legacy=normalizeCompliance({score:88,reason:'旧记录',updatedAt:1700000000000});
  assert.equal(legacy.status,'qualified');assert.equal(legacy.legacyScore,88);assert.equal(legacy.updatedAt,1700000000000);
  // 首次建档时直接带合规字段，也应补齐更新时间并通过校验。
  const fresh=emptyState();
  const nid=addCompany(fresh,'带合规的新公司',{compliance:{status:'severe',reason:'证书失效'}}).id;
  assert.equal(fresh.companies[nid].compliance.status,'severe');
  assert.ok(Number.isSafeInteger(fresh.companies[nid].compliance.updatedAt));
  assert.equal(validateState(fresh).companies[nid].compliance.reason,'证书失效');
  console.log('✓ 公司合规四色状态 / 默认未核实 / 原因 / 旧分数迁移');
}
{
  const {s,a,b,c}=scenario(); const r=addCompany(s,'总装R').id,x=addCompany(s,'上游X').id,y=addCompany(s,'上游Y').id;
  assignCompany(s,a,r);assignCompany(s,b,x);assignCompany(s,c,y);
  linkCompany(s,b,r,x);linkCompany(s,c,r,y);
  const did=s.diagrams[0].id;
  setRiskAssessment(s,did,r,{score:62,categories:["supply","quality"],note:"X 为单源"});
  const validated=validateState(s);
  assert.equal(validated.diagrams[0].risks[r].score,62);
  assert.equal(validated.diagrams[0].risks[r].categories.join(","),"supply,quality");
  assert.throws(()=>setRiskAssessment(s,did,r,{score:101,categories:[],note:""}),/Risk score must be between 0 and 100/);
  assert.throws(()=>setRiskAssessment(s,did,r,{score:50,categories:["unknown"],note:""}),/Invalid risk category/);
  assert.throws(()=>setRiskAssessment(s,'d999',r,{score:50,categories:[],note:""}),/BOM/);
  assert.throws(()=>setRiskAssessment(s,did,'c999',{score:50,categories:[],note:""}),/Company not found/);
  const bad=clone(s); bad.diagrams[0].risks[r].categories=["nope"];
  assert.throws(()=>validateState(bad),/Invalid risk category/);
  const badRef=clone(s); badRef.diagrams[0].risks.c999={score:10,categories:[],note:"",updatedAt:null};
  assert.throws(()=>validateState(badRef),/Invalid company reference in risk rating/);
  clearRiskAssessment(s,did,r);
  assert.equal(s.diagrams[0].risks[r],undefined);
  console.log('✓ 供应链风险分数 / 类别 / 引用与校验');
}
{
  const {s,a,b}=scenario(); const r=addCompany(s,'合并主档').id; assignCompany(s,a,r);
  const y='c998'; s.companies[y]={...clone(s.companies[r]),id:y,name:'  合并主档  ',compliance:{status:'risk',reason:'旧记录',updatedAt:null,legacyScore:71}};
  s.nodes[b].companyIds=[y];
  const did=s.diagrams[0].id;
  setRiskAssessment(s,did,y,{score:66,categories:["delivery"],note:'旧评定'});
  mergeCompanyRecords(s,r,[y]);
  assert.equal(s.diagrams[0].risks[y],undefined);
  assert.equal(s.diagrams[0].risks[r].score,66);
  assert.equal(s.companies[r].compliance.status,'risk','主档未核实时继承被合并档案');
  assert.equal(validateState(s).version,7);
  console.log('✓ 合并同名公司时风险评定改指主档并保留');
}
{
  const {s,a,b}=scenario(); const r=addCompany(s,'V4 接收方').id;
  setRiskAssessment(s,s.diagrams[0].id,r,{score:40,categories:["geo"],note:'保留'});
  const raw=clone(validateState(s));
  raw.version=4;
  for(const c of Object.values(raw.companies))delete c.compliance;
  for(const d of raw.diagrams)delete d.risks;
  const upgraded=validateState(raw);
  assert.equal(upgraded.version,7);
  assert.equal(upgraded.companies[r].compliance.status,'unverified');assert.equal(upgraded.companies[r].compliance.reason,"");assert.equal(upgraded.companies[r].compliance.updatedAt,null);
  assert.equal(Object.keys(upgraded.diagrams[0].risks).length,0);
  // 手工写入的 v4 合规数据补齐 updatedAt，并归档旧分数、转为四色状态。
  const partial=clone(raw); partial.version=4; partial.companies[r].compliance={score:77,reason:'手工填写'};
  const upgraded2=validateState(partial);
  assert.equal(upgraded2.companies[r].compliance.status,'qualified');
  assert.equal(upgraded2.companies[r].compliance.legacyScore,77);
  assert.equal(upgraded2.companies[r].compliance.updatedAt,null);
  console.log('✓ v4 → v7：合规状态与风险字段的默认迁移');
}
{
  // 新界面状态与模型枚举保持一致；旧风险类别仅作为兼容校验保留。
  const riskSource=fs.readFileSync(require('path').join(__dirname,'..','js','risk-view.js'),'utf8');
  assert.ok(!riskSource.includes('riskScoreRange'));
  assert.ok(!riskSource.includes('analyzeSupplyRisk'));
  assert.ok(riskSource.includes('ASSESSMENT_MARKETS'));
  assert.ok(riskSource.includes('ASSESSMENT_STATUSES'));
  assert.equal(ASSESSMENT_STATUSES.length,3);
  console.log('✓ 第三页已移除系统评分，保留统一准入状态');
}
{
  // 内置示例必须始终是一份通过 v5 校验、且包含模拟缺口的完整供应链。
  const sampleSource=fs.readFileSync(require('path').join(__dirname,'..','js','sample-data.js'),'utf8');
  const ctx={};vm.createContext(ctx);
  vm.runInContext(source+"\n"+sampleSource+";this.sampleState=SAMPLE_BOM_STATE;",ctx);
  const sample=validateState(ctx.sampleState);
  assert.equal(sample.version,7);
  assert.ok(Object.keys(sample.nodes).length>=20,'示例至少 20 个组件位置');
  assert.ok(Object.keys(sample.companies).length>=20,'示例至少 20 家公司');
  assert.ok(Object.keys(sample.factories).length>=20,'示例至少 20 座工厂');
  const linkCount=Object.values(sample.relationships).reduce((n,rows)=>n+Object.values(rows).reduce((m,ups)=>m+ups.length,0),0);
  assert.ok(linkCount>=20,'示例至少 20 条公司供货关系');
  const root=sample.nodes[sample.diagrams[0].rootNodeId];
  const rootCid=groupOf(sample,root.id)[0];
  assert.ok(rootCid,'成品必须关联最终组装公司');
  assert.equal(sample.diagrams[0].risks[rootCid].score,68,'历史风险记录应保留但不用于新准入页');
  assert.equal(Object.keys(sample.diagrams[0].assessments).length,0,'示例评估从人工空白记录开始');
  assert.ok(Object.values(sample.nodes).some(node=>!groupOf(sample,node.id).length),'保留未关联公司的模拟缺口');
  const sampleStatuses=Object.values(sample.companies).reduce((acc,c)=>{acc[c.compliance.status]=(acc[c.compliance.status]||0)+1;return acc;},{});
  assert.equal(sampleStatuses.severe,2,'示例保留两家严重违规上游，便于验证风险提示');
  assert.equal(sampleStatuses.unverified,1,'示例保留一家未核实公司');
  assert.ok(upstreamCompanyIds(sample,sample.diagrams[0].id,rootCid).some(cid=>sample.companies[cid].compliance.status==='severe'),'成品上游存在红色状态企业');
  console.log('✓ 内置示例供应链通过 v7 校验（四色状态 / 21 位置 / 21 公司 / 25 工厂）');
}
{
  // 上游遍历只沿当前 BOM 的供货关系；红/黄状态用于市场页确定性提示。
  const {s,a,b}=scenario(), r=addCompany(s,'成品R').id, x=addCompany(s,'一级供应X').id, y=addCompany(s,'二级供应Y').id;
  assignCompany(s,a,r);assignCompany(s,b,x);
  const d=addNode(s,b,{name:'D',qty:1,unit:'件'});assignCompany(s,d,y);
  linkCompany(s,b,r,x);linkCompany(s,d,x,y);
  setCompanyCompliance(s,x,{status:'severe',reason:'证书失效'});
  setCompanyCompliance(s,y,{status:'risk',reason:'报告过期'});
  const did=s.diagrams[0].id;
  assert.deepEqual([...upstreamCompanyIds(s,did,r)],[x,y]);
  assert.deepEqual([...upstreamCompanyIds(s,did,x)],[y]);
  assert.deepEqual([...upstreamCompanyIds(s,did,y)],[]);
  assert.equal(s.companies[x].compliance.status,'severe');
  assert.equal(s.companies[y].compliance.status,'risk');
  console.log('✓ 成品上游供货链遍历：红/黄状态可被市场页读取');
}
{
  // 公司总览下游追溯：只保留起点可达的下游，边唯一，不混入无关公司。
  const {s,a,b}=scenario(), r=addCompany(s,'最终总装R').id, x=addCompany(s,'一级供应X').id, y=addCompany(s,'二级供应Y').id, z=addCompany(s,'三级供应Z').id, unrelated=addCompany(s,'无关公司U').id;
  assignCompany(s,a,r);assignCompany(s,b,x);
  const d=addNode(s,b,{name:'D',qty:1,unit:'件'}), e=addNode(s,d,{name:'E',qty:1,unit:'件'});
  assignCompany(s,d,y);assignCompany(s,e,z);
  linkCompany(s,b,r,x);linkCompany(s,d,x,y);linkCompany(s,e,y,z);
  const graph=companyDownstreamGraph(s,z);
  assert.equal(graph.nodes.join(','),[z,y,x,r].join(','),'只包含起点及可达下游');
  assert.equal(graph.edges.length,3);
  assert.ok(!graph.nodes.includes(unrelated));
  assert.equal(graph.edges.filter(([up,down])=>up===y&&down===x).length,1,'同一对公司只保留一条边');
  assert.equal(graph.adjacency.get(y).has(x),true);
  const fromY=companyDownstreamGraph(s,y);
  assert.equal(fromY.nodes.join(','),[y,x,r].join(','));
  const leaf=companyDownstreamGraph(s,r);
  assert.equal(leaf.nodes.join(','),r);assert.equal(leaf.edges.length,0);
  assert.equal(companyDownstreamGraph(s,'c999').nodes.length,0);
  console.log('✓ 公司下游追溯：隐藏无关公司 / 可达下游 / 唯一边 / 终点');
}

{
  const {s,a,b}=scenario(), r=addCompany(s,'成品评估主体A').id, r2=addCompany(s,'成品评估主体B').id;
  assignCompany(s,a,r);assignCompany(s,a,r2);
  const did=s.diagrams[0].id;
  const evidence=[{id:'a1',title:'材料证明',detail:'由人工核实的测试资料',source:'报告编号 X-001'}];
  const pendingItems=[{id:'a2',title:'核查法规适用性',detail:'人工待确认'}];
  setMarketAssessment(s,did,r,'eu',{status:'pending',evidence,pendingItems});
  setMarketAssessment(s,did,r,'us',{status:'blocked',evidence,pendingItems});
  setMarketAssessment(s,did,r2,'eu',{status:'pending',evidence:[],pendingItems:[]});
  assert.equal(assessmentOf(s,did,r,'eu').status,'pending');
  assert.equal(assessmentOf(s,did,r,'us').status,'blocked');
  assert.equal(assessmentOf(s,did,r2,'eu').evidence.length,0);
  assert.equal(validateState(s).diagrams[0].assessments[r].eu.evidence.length,1);
  assert.throws(()=>setMarketAssessment(s,did,r,'eu',{status:'verified',evidence,pendingItems}),/Cannot mark Verified while pending items remain/);
  assert.throws(()=>setMarketAssessment(s,did,r,'eu',{status:'verified',evidence:[],pendingItems:[]}),/Add at least one piece of evidence before confirming status/);
  assert.throws(()=>setMarketAssessment(s,did,r,'eu',{status:'blocked',evidence:[],pendingItems:[]}),/Add at least one piece of evidence before confirming status/);
  assert.throws(()=>setMarketAssessment(s,did,r,'fr',{status:'pending',evidence:[],pendingItems:[]}),/Select a valid target market/);
  assert.throws(()=>setMarketAssessment(s,did,'c999','eu',{status:'pending',evidence:[],pendingItems:[]}),/Subject must be linked to the finished product node/);
  assert.throws(()=>setMarketAssessment(s,'d999',r,'eu',{status:'pending',evidence:[],pendingItems:[]}),/BOM/);
  setMarketAssessment(s,did,r,'eu',{status:'verified',evidence,pendingItems:[]});
  assert.equal(assessmentOf(s,did,r,'us').status,'blocked','其他市场不能被覆盖');
  clearMarketAssessment(s,did,r,'us');
  assert.equal(assessmentOf(s,did,r,'us'),null);
  assert.equal(assessmentOf(s,did,r,'eu').status,'verified','清除单个市场不影响其他记录');
  assert.equal(validateState(JSON.parse(JSON.stringify(s))).version,7,'导出、导入往返可用');
  console.log('✓ 公司 × 市场隔离 / 人工准入约束 / 增删与备份往返');
}
{
  const {s,a}=scenario(), keep=addCompany(s,'相同公司').id;
  assignCompany(s,a,keep);
  const same='c900';s.companies[same]={...clone(s.companies[keep]),id:same,name:' 相同 公司 '};
  assignCompany(s,a,same);
  const did=s.diagrams[0].id;
  setMarketAssessment(s,did,keep,'eu',{status:'verified',evidence:[{id:'a1',title:'证明A',detail:'',source:'A'}],pendingItems:[]});
  setMarketAssessment(s,did,same,'eu',{status:'blocked',evidence:[{id:'a1',title:'证明B',detail:'',source:'B'}],pendingItems:[{id:'a3',title:'复核',detail:''}]});
  mergeCompanyRecords(s,keep,[same]);
  assert.equal(s.diagrams[0].assessments[same],undefined);
  assert.equal(assessmentOf(s,did,keep,'eu').status,'pending','冲突评估不能自动选较宽松状态');
  assert.equal(assessmentOf(s,did,keep,'eu').evidence.length,2,'合并须保留双方证据');
  assert.equal(validateState(s).version,7);
  console.log('✓ 合并同名公司：冲突证据均保留、状态退回待核实');
}
{
  const {s,a}=scenario(),r=addCompany(s,'V5 总装').id;
  assignCompany(s,a,r);
  s.companies[r].compliance={score:47,reason:'旧合规记录',updatedAt:1700000000001};
  setRiskAssessment(s,s.diagrams[0].id,r,{score:58,categories:['supply'],note:'旧分数'});
  const v5=clone(s);v5.version=5;
  for(const d of v5.diagrams)delete d.assessments;
  const upgraded=validateState(v5);
  assert.equal(upgraded.version,7);
  assert.equal(upgraded.diagrams[0].risks[r].score,58,'旧风险分数不能丢');
  assert.equal(Object.keys(upgraded.diagrams[0].assessments).length,0,'不能自动将旧分数映射为准入状态');
  assert.equal(upgraded.companies[r].compliance.status,'severe','旧合规分 47 转为严重违规');
  assert.equal(upgraded.companies[r].compliance.legacyScore,47,'旧合规分保留追溯');
  console.log('✓ v5 → v7：旧风险分只归档；旧合规分转四色状态并保留追溯');
}
console.log('全部模型测试通过。');
